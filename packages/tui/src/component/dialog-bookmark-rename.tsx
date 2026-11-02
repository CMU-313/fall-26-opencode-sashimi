import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { bookmarkTitle, useLocal } from "../context/local"
import { useToast } from "../ui/toast"
import { createMemo } from "solid-js"
import { errorMessage } from "../util/error"

//This shows the prompt for renaming a bookmark
interface DialogBookmarkRenameProps {
  bookmark: string
}

export function DialogBookmarkRename(props: DialogBookmarkRenameProps) {
  const dialog = useDialog()
  const local = useLocal()
  const toast = useToast()
  const bookmark = createMemo(() => local.bookmark.list().find((item) => item.id === props.bookmark))

  return (
    <DialogPrompt
      title="Rename Bookmark"
      value={bookmark() ? bookmarkTitle(bookmark()!) : ""}
      onConfirm={(value) => {
        //Fills name with truncated response, then allows user to edit from there
        void local.bookmark.rename(props.bookmark, value).catch((error) => {
          toast.show({ message: `Failed to rename bookmark: ${errorMessage(error)}`, variant: "error" })
        })
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
