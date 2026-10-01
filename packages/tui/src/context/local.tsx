import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { isMissingFileError, readJson, writeJsonAtomic } from "../util/persistence"
import { rename } from "fs/promises"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { usePermission } from "./permission"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

// Added a bookmark type with fields to identify it 
export type LocalBookmark = {
  id: string
  sessionID: string
  sessionTitle: string
  text: string
  createdAt: number
  name?: string
}
//This function checks to make sure the bookmarks from bookmark.json
//that are read in have the proper fields, so bad entries can be filtered out
function isLocalBookmark(value: unknown): value is LocalBookmark {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === "string" &&
    typeof item.sessionID === "string" &&
    typeof item.sessionTitle === "string" &&
    typeof item.text === "string" &&
    typeof item.createdAt === "number" &&
    (item.name === undefined || typeof item.name === "string")
  )
}

// Loads bookmarks from a real bookmark.json on disk, handling every way that
// file can be missing or broken so callers don't have to. A missing file just
// means there are no bookmarks yet (empty list, same as the fresh-install
// case). Anything else wrong with it - invalid JSON, an unexpected shape -
// means the file exists but couldn't be used, so it's backed up (renamed with
// a `.corrupt-<timestamp>` suffix) rather than silently treated as empty and
// overwritten on the next save, which would destroy whatever was in it.
// Exported (and operating on a real filePath, not a mocked one) so the actual
// save/load/corruption-recovery behavior can be tested against the real
// filesystem, not just the error-classification logic underneath it.
export async function loadBookmarks(filePath: string): Promise<LocalBookmark[]> {
  try {
    const data = await readJson<unknown>(filePath)
    if (!data || typeof data !== "object") return []
    const items = (data as Record<string, unknown>).items
    if (!Array.isArray(items)) return []
    return items.filter(isLocalBookmark)
  } catch (error) {
    if (isMissingFileError(error)) return []
    await rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => {})
    return []
  }
}

// Writes the given bookmarks to a real bookmark.json on disk, atomically (see
// writeJsonAtomic). Paired with loadBookmarks as the other half of the
// save/load round trip, and tested the same way - against real files.
export async function saveBookmarks(filePath: string, items: LocalBookmark[]) {
  await writeJsonAtomic(filePath, { items })
}

//Returns an array of bookmarks without the one removed
export function removeBookmark(items: LocalBookmark[], id: string) {
  return items.filter((item) => item.id !== id)
}
//If a bookmark with a specific id already exists it is removed, otherwise a new one is created
//result exists so the correct message is shown depending on whether we are looking at a 
//current bookmark or a non existing one
export function toggleBookmark(items: LocalBookmark[], entry: Omit<LocalBookmark, "createdAt">) {
  const exists = items.some((item) => item.id === entry.id)
  return {
    items: exists ? removeBookmark(items, entry.id) : [...items, { ...entry, createdAt: Date.now() }],
    result: exists ? ("removed" as const) : ("added" as const),
  }
}

export function renameBookmark(items: LocalBookmark[], id: string, name: string) {
  const trimmed = name.trim()
  return items.map((item) => (item.id === id ? { ...item, name: trimmed || undefined } : item))
}

// Removes every bookmark belonging to the given session, leaving bookmarks
// from other sessions untouched. Used to clean up bookmarks once their
// session no longer exists (see the "session.deleted" handler below).
export function pruneBookmarksForSession(items: LocalBookmark[], sessionID: string) {
  return items.filter((item) => item.sessionID !== sessionID)
}

// Newest-first ordering for the saved-bookmarks list (dialog-bookmark-list.tsx).
// Pulled out as its own function, like the other bookmark helpers, so the
// ordering can be tested without spinning up the full local context.
export function sortBookmarks(items: LocalBookmark[]) {
  return items.toSorted((a, b) => b.createdAt - a.createdAt)
}

// Reconciles two TUI sessions writing to the same bookmark.json at once.
// Without this, the second session's save() would just overwrite the file
// with its own in-memory list, silently losing whatever the first session
// had just added - no error, no warning, the bookmark is just gone.
//
// `base` is the last state this session knows it shared with disk (what it
// loaded at startup, or the result of its last successful save). `mine` is
// this session's current in-memory list. `theirs` is whatever is on disk
// right now, freshly re-read immediately before writing.
//
// For each bookmark id, a three-way diff against `base` tells added from
// removed: an id missing from `mine` that was already missing from `base`
// is new (added by the other session, since base) - keep it. An id missing
// from `mine` that `base` DID have is a deletion made by someone, so it's
// dropped rather than resurrected - this is what keeps a local remove() from
// coming back to life just because the other session's copy still has it.
// The same logic applies symmetrically to `theirs`. An id present in both
// `mine` and `theirs` keeps mine's version, since that's whatever this
// session just changed (e.g. a rename) and is presumably the freshest edit.
export function mergeBookmarks(
  base: LocalBookmark[],
  mine: LocalBookmark[],
  theirs: LocalBookmark[],
): LocalBookmark[] {
  const baseIds = new Set(base.map((item) => item.id))
  const mineById = new Map(mine.map((item) => [item.id, item]))
  const theirsById = new Map(theirs.map((item) => [item.id, item]))
  const allIds = new Set([...mineById.keys(), ...theirsById.keys()])

  const result: LocalBookmark[] = []
  for (const id of allIds) {
    const inMine = mineById.has(id)
    const inTheirs = theirsById.has(id)
    const inBase = baseIds.has(id)

    if (inMine && inTheirs) {
      result.push(mineById.get(id)!)
    } else if (inMine && !inTheirs) {
      if (!inBase) result.push(mineById.get(id)!)
    } else if (!inMine && inTheirs) {
      if (!inBase) result.push(theirsById.get(id)!)
    }
  }
  return result
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const permission = usePermission()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((item) => item.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    function createAgent() {
      const agents = createMemo(() => sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((agent) => !agent.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const value = x as Record<string, unknown>
          if (Array.isArray(value.recent)) setModelStore("recent", value.recent)
          if (Array.isArray(value.favorite)) setModelStore("favorite", value.favorite)
          if (typeof value.variant === "object" && value.variant !== null)
            setModelStore("variant", value.variant as Record<string, string | undefined>)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => a && modelStore.model[a.name],
            () => a && a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((item) => item.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...next })
          setModelStore("recent", recentModels(next, modelStore.recent))
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const a = agent.current()
            if (!a) return
            setModelStore("model", a.name, model)
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((item) => item.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value ?? "default")
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const slots = createMemo(() => {
        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()
//Sets up bookmark persistence: loads bookmark.json on startup, 
// keeps it in sync with the reactive store, 
//and exposes list/toggle/remove/rename as the only way the rest of the app touches bookmarks.
    function createBookmark() {
      const [bookmarkStore, setBookmarkStore] = createStore<{
        ready: boolean
        items: LocalBookmark[]
      }>({
        ready: false,
        items: [],
      })

      const filePath = path.join(paths.state, "bookmark.json")
      const state = {
        pending: false,
      }
      // The last state this session knows it shared with disk - either what
      // it loaded at startup, or the result of its own last successful save.
      // Used to tell "added elsewhere since we last synced" apart from
      // "deliberately removed" when merging with another TUI session. See
      // mergeBookmarks for why this is needed.
      let baseline: LocalBookmark[] = []

      // Awaited by callers so a failed write (e.g. disk full) surfaces as a
      // thrown error instead of silently reporting success. Re-reads the
      // file immediately before writing and merges with it, so a second TUI
      // session saving around the same time doesn't silently clobber this
      // session's bookmarks (or vice versa).
      async function save() {
        if (!bookmarkStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        const onDisk = await loadBookmarks(filePath)
        const merged = mergeBookmarks(baseline, bookmarkStore.items, onDisk)
        await saveBookmarks(filePath, merged)
        baseline = merged
        setBookmarkStore("items", merged)
      }

      loadBookmarks(filePath)
        .then((items) => {
          baseline = items
          setBookmarkStore("items", items)
        })
        .finally(() => {
          setBookmarkStore("ready", true)
          if (state.pending) void save().catch(() => {})
        })

      function prune(sessionID: string) {
        const remaining = pruneBookmarksForSession(bookmarkStore.items, sessionID)
        if (remaining.length === bookmarkStore.items.length) return
        setBookmarkStore("items", remaining)
        void save().catch(() => {})
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        list() {
          return sortBookmarks(bookmarkStore.items)
        },
        has(id: string) {
          return bookmarkStore.items.some((item) => item.id === id)
        },
        async remove(id: string) {
          const previous = bookmarkStore.items
          setBookmarkStore("items", removeBookmark(bookmarkStore.items, id))
          try {
            await save()
          } catch (error) {
            setBookmarkStore("items", previous)
            throw error
          }
        },
        async toggle(entry: Omit<LocalBookmark, "createdAt">) {
          const previous = bookmarkStore.items
          const { items, result } = toggleBookmark(bookmarkStore.items, entry)
          setBookmarkStore("items", items)
          try {
            await save()
          } catch (error) {
            setBookmarkStore("items", previous)
            throw error
          }
          return result
        },
        async rename(id: string, name: string) {
          const previous = bookmarkStore.items
          setBookmarkStore("items", renameBookmark(bookmarkStore.items, id, name))
          try {
            await save()
          } catch (error) {
            setBookmarkStore("items", previous)
            throw error
          }
        },
      }
    }

    const bookmark = createBookmark()

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
      session,
      bookmark,
      permission,
    }
    return result
  },
})
