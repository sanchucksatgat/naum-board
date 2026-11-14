import { useEffect, useRef, useState } from "preact/hooks";

/**
 * 사진 크게 보기. `openImageViewer([{ src, alt }], 0)`. <ViewerHost/> 를 한 번 둔다 (UiHost 에 있음).
 * - 확대: 단추(＋/－), 두 번 누르기, 키보드 +/−. 확대하면 끌거나 스크롤해서 움직인다.
 * - 여러 장이면 ←/→ 로 넘긴다. Esc 로 닫는다.
 */
export interface ViewerImage {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  /** 원본 열기 주소 (없으면 src) */
  href?: string;
}

let state: { images: ViewerImage[]; index: number } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function openImageViewer(images: ViewerImage[], index = 0): void {
  if (!images.length) return;
  state = { images, index: Math.max(0, Math.min(index, images.length - 1)) };
  emit();
}

function closeViewer() {
  state = null;
  emit();
}

const ZOOMS = [1, 2, 3];

export function ViewerHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  if (!state) return null;
  return <Viewer key={state.images.map((i) => i.src).join("|")} images={state.images} start={state.index} />;
}

function Viewer(props: { images: ViewerImage[]; start: number }) {
  const [index, setIndex] = useState(props.start);
  const [zoom, setZoom] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const img = props.images[index]!;
  const many = props.images.length > 1;

  const go = (d: number) => {
    setZoom(0);
    setIndex((i) => (i + d + props.images.length) % props.images.length);
  };

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    document.documentElement.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeViewer();
      } else if (e.key === "ArrowRight" && many) go(1);
      else if (e.key === "ArrowLeft" && many) go(-1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(ZOOMS.length - 1, z + 1));
      else if (e.key === "-") setZoom((z) => Math.max(0, z - 1));
      else if (e.key === "Tab") {
        // 단추들 안에서만 돈다
        const items = Array.from(document.querySelectorAll<HTMLElement>(".ui-viewer button, .ui-viewer a"));
        const i = items.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        const n = items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length];
        n?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.documentElement.style.overflow = "";
      prev?.focus({ preventScroll: true });
    };
  }, []);

  // 확대하면 가운데로
  useEffect(() => {
    const b = boxRef.current;
    if (!b) return;
    b.scrollLeft = (b.scrollWidth - b.clientWidth) / 2;
    b.scrollTop = (b.scrollHeight - b.clientHeight) / 2;
  }, [zoom, index]);

  const z = ZOOMS[zoom]!;
  return (
    <div class="ui-viewer" role="dialog" aria-modal="true" aria-label="사진 크게 보기">
      <div class="ui-viewer-bar">
        <span class="ui-viewer-count">{many ? `${index + 1} / ${props.images.length}` : ""}</span>
        <div class="row">
          <button type="button" class="btn btn-small ui-viewer-btn" aria-label="작게" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)}>
            －
          </button>
          <button
            type="button"
            class="btn btn-small ui-viewer-btn"
            aria-label="크게"
            disabled={zoom === ZOOMS.length - 1}
            onClick={() => setZoom(zoom + 1)}
          >
            ＋
          </button>
          <a class="btn btn-small ui-viewer-btn" href={img.href ?? img.src} target="_blank" rel="noopener noreferrer">
            원본
          </a>
          <button ref={closeRef} type="button" class="btn btn-small ui-viewer-btn" onClick={closeViewer}>
            ✕ 닫기
          </button>
        </div>
      </div>
      <div
        ref={boxRef}
        class={"ui-viewer-stage" + (z > 1 ? " is-zoomed" : "")}
        onClick={(e) => {
          if (e.target === e.currentTarget && z === 1) closeViewer();
        }}
        onPointerDown={(e) => {
          if (z === 1 || e.pointerType === "touch") return;
          const b = boxRef.current!;
          drag.current = { x: e.clientX, y: e.clientY, sl: b.scrollLeft, st: b.scrollTop };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const b = boxRef.current!;
          b.scrollLeft = d.sl - (e.clientX - d.x);
          b.scrollTop = d.st - (e.clientY - d.y);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        <img
          src={img.src}
          alt={img.alt}
          draggable={false}
          class="ui-viewer-img"
          style={z > 1 ? { width: `${z * 100}%`, maxWidth: "none", maxHeight: "none" } : undefined}
          onDblClick={() => setZoom(zoom === 0 ? 1 : 0)}
        />
      </div>
      {many ? (
        <>
          <button type="button" class="ui-viewer-nav ui-viewer-prev" aria-label="이전 사진" onClick={() => go(-1)}>
            ‹
          </button>
          <button type="button" class="ui-viewer-nav ui-viewer-next" aria-label="다음 사진" onClick={() => go(1)}>
            ›
          </button>
        </>
      ) : null}
    </div>
  );
}
