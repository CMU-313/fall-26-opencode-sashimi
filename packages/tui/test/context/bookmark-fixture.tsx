/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../src/context/args"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider } from "../../src/context/project"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { PermissionProvider } from "../../src/context/permission"
import { ExitProvider } from "../../src/context/exit"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { ToastProvider } from "../../src/ui/toast"
import { TuiConfigProvider } from "../../src/config"
import { LocalProvider, useLocal } from "../../src/context/local"
import { createEventSource, createFetch, type FetchHandler, directory } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
export { createEventSource, createFetch, directory, json, worktree } from "../fixture/tui-sdk"

export async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

// Same as wait(), but for an async predicate - used to poll the real
// bookmark.json on disk (via loadBookmarks) rather than in-memory state,
// since a save triggered by an event handler isn't awaited by the caller.
export async function waitAsync(fn: () => Promise<boolean>, timeout = 2000) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

// Mounts the real provider stack LocalProvider actually runs inside in the app
// (see src/app.tsx), pointed at a given state directory, so bookmark tests can
// exercise the real reactive wiring - a real SDK event triggering a real
// prune-and-save, two separate mounts sharing one bookmark.json - rather than
// calling the extracted pure/file-level functions directly.
export async function mount(state: string, override?: FetchHandler) {
  const calls = createFetch(override)
  const events = createEventSource()
  let local!: ReturnType<typeof useLocal>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    const ctx = useLocal()
    onMount(() => {
      local = ctx
      done()
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={{ state }}>
      <ArgsProvider>
        <KVProvider>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                  <PermissionProvider>
                    <ProjectProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <RouteProvider>
                            <LocalProvider>
                              <Probe />
                            </LocalProvider>
                          </RouteProvider>
                        </SyncProvider>
                      </ExitProvider>
                    </ProjectProvider>
                  </PermissionProvider>
                </SDKProvider>
              </ToastProvider>
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </ArgsProvider>
    </TestTuiContexts>
  ))

  await ready
  return { app, emit: events.emit, local, session: calls.session }
}
