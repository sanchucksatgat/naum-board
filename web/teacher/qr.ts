/** QR 코드: 브라우저 안에서 만든다 (외부 QR 서비스 없음). uqr 로 행렬을 만들고 SVG 경로로 바꾼다. */
import { encode } from "uqr";

export interface QrPath {
  /** 테두리 포함 한 변의 칸 수 */
  size: number;
  /** SVG path d (검은 칸) */
  d: string;
}

/** 문자열 → QR 행렬 (true = 검은 칸). 테두리(quiet zone) 4칸 포함 */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: "M", border: 4 }).data;
}

export function qrPath(text: string): QrPath {
  const data = qrMatrix(text);
  let d = "";
  data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return { size: data.length, d };
}
