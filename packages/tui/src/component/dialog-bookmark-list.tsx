import { createMemo } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useLocal } from "../context/local"
import { useToast } from "../ui/toast"
import { Locale } from "../util/locale"
import { errorMessage } from "../util/error"
import { DialogBookmarkRename } from "./dialog-bookmark-rename"

export function DialogBookmarkList() {
  const dialog = useDialog()
  const route = useRoute()
  const local = useLocal()
  const toast = useToast()

  const options = createMemo(() => {
    const today = new Date().toDateString()
    return local.bookmark.list().map((bookmark) => {
      const label = new Date(bookmark.createdAt).toDateString()
      return {
        title: bookmark.name || Locale.truncate(bookmark.text.replace(/\s+/g, " ").trim(), 80),
        value: bookmark.id,
        category: label === today ? "Today" : label,
        footer: bookmark.sessionTitle,
      }
    })
  })

  return (
    <DialogSelect
      title="Bookmarked Responses"
      options={options()}
      emptyView={<text>No bookmarked responses yet</text>}
      onSelect={(option) => {
        const bookmark = local.bookmark.list().find((item) => item.id === option.value)
        if (!bookmark) return
        route.navigate({
          type: "session",
          sessionID: bookmark.sessionID,
          messageID: bookmark.id,
        })
        dialog.clear()
      }}
      actions={[
        {
          command: "session.bookmark.rename",
          title: "rename",
          onTrigger: (option) => {
            dialog.replace(() => <DialogBookmarkRename bookmark={option.value} />)
          },
        },
        {
          command: "session.bookmark.remove",
          title: "remove",
          onTrigger: (option) => {
            void local.bookmark.remove(option.value).catch((error) => {
              toast.show({ message: `Failed to remove bookmark: ${errorMessage(error)}`, variant: "error" })
            })
          },
        },
      ]}
    />
  )
}
