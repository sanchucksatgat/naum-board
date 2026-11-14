/** 학생 보드 화면 자리표시자 (이후 태스크에서 구현) */
export function StudentBoardPage(props: { params: Record<string, string> }) {
  return (
    <main>
      <h1>보드 입장</h1>
      <p>입장 코드: {props.params.code}</p>
      <p>준비 중이에요.</p>
    </main>
  );
}
