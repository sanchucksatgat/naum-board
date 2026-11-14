import type { ComponentType } from "preact";

/** 교사 전용 부품 (web/board/teacher/index.tsx 를 따로 불러온다 → 학생 화면은 이 코드를 받지 않음) */
export interface TeacherModule {
  /** 카드 아래 교사 단추: 승인·숨김·피드백·지우기 */
  CardActions: ComponentType<{ postId: string }>;
  /** 윗줄 교사 도구: 설정 토글, 공지 쓰기, 프로젝터, 미제출, 백업 */
  TeacherBar: ComponentType<Record<string, never>>;
  /** 주제별 열 머리의 관리 단추 */
  ColumnMenu: ComponentType<{ columnId: string }>;
  /** 주제별 열 추가 */
  AddColumn: ComponentType<Record<string, never>>;
  /** 공지 고치기·지우기 */
  NoticeActions: ComponentType<{ noticeId: string }>;
  /** 공지 쓰기 단추 */
  NewNoticeButton: ComponentType<{ compact?: boolean }>;
}
