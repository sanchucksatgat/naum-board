/**
 * 주제별 보드를 만들 때 주제(열) 이름을 넣는다.
 * REST 보드 만들기에는 열 목록이 없으므로, 교사 쿠키로 보드 웹소켓에 잠깐 붙어 column.save 를 보낸다 (PROTOCOL §3).
 * 서버는 주제별 보드를 만들 때 "주제 1" 열을 하나 만들어 두므로, 첫 주제는 그 열의 이름을 바꾼다.
 */
import type { ClientMessage, ColumnView, ServerMessage } from "../../src/shared/protocol";

function opId(): string {
  return (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, "");
}

export function applyTopics(code: string, topics: string[], timeoutMs = 10_000): Promise<void> {
  if (!topics.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/boards/${encodeURIComponent(code)}/ws`);
    const pending = new Map<string, true>();
    let started = false;
    const timer = setTimeout(() => finish(new Error("주제 이름을 저장하지 못했어요. 보드 화면에서 열 이름을 바꿔 주세요.")), timeoutMs);
    function finish(err?: Error) {
      clearTimeout(timer);
      try {
        ws.close(1000);
      } catch {
        /* 이미 닫힘 */
      }
      if (err) reject(err);
      else resolve();
    }
    const send = (m: ClientMessage) => {
      if (m.t !== "sync") pending.set(m.opId, true);
      ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === "snapshot" && !started) {
        started = true;
        const cols: ColumnView[] = msg.snapshot.columns.filter((c) => c.kind === "topic");
        topics.forEach((title, i) => {
          const existing = cols[i];
          send({ t: "column.save", opId: opId(), column: existing ? { id: existing.id, title } : { title } });
        });
      } else if (msg.t === "ack") {
        pending.delete(msg.opId);
        if (started && pending.size === 0) finish();
      } else if (msg.t === "error" && msg.opId) {
        finish(new Error(msg.message));
      }
    };
    ws.onerror = () => finish(new Error("보드에 연결하지 못해 주제 이름을 저장하지 못했어요. 보드 화면에서 열 이름을 바꿔 주세요."));
    ws.onclose = () => {
      if (pending.size || !started) finish(new Error("보드 연결이 끊겨 주제 이름을 다 저장하지 못했어요. 보드 화면에서 확인해 주세요."));
    };
  });
}
