import "./tokens.css";
import "./ui.css";
import { ToastArea } from "./Toast";
import { DialogHost } from "./ConfirmDialog";
import { ViewerHost } from "./ImageViewer";

/** 화면마다 한 번 두는 공용 자리 (토스트·확인 대화상자·사진 보기) */
export function UiHost() {
  return (
    <>
      <DialogHost />
      <ViewerHost />
      <ToastArea />
    </>
  );
}
