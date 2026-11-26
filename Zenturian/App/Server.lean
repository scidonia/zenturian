import LeanIn
import LeanIn.Http.Server
import LeanIn.Http.H1
import LeanIn.Sched.Executor
import Zenturian.Http.Router

/-!
# The server

LeanIn's listener, executor and HTTP/1.1 driver, assembled directly: bind `127.0.0.1` (port `0`
asks the OS for one), report the address actually bound, and serve every accepted connection
through `serveConnStream` with this application's route table. There is no server framework and no
router framework — only the runtime's own loop and the table in `Zenturian.Http.Router`.

The transport body cap is set far above the application's 1 MiB, because LeanIn's own 413 is
status-only: a request a caller will practically send reaches the handler, which is where the
shared capped reader and the seam's JSON `413 body_too_large` body live once a route reads a body.
This item's route reads none.
-/

namespace Zenturian.App

open LeanIn
open LeanIn.Http
open LeanIn.Runtime

/-- What `zenturianLean health` accepts. `--port 0` (the default) makes the OS choose, and the bound
address is printed, so no caller guesses a port. -/
structure Options where
  port : UInt16 := 0
  workers : Nat := 1
deriving Inhabited, Repr

/-- The application's route table. Later items append to it; this one entry is the health probe. -/
def routes : Zenturian.Http.Router :=
  ({} : Zenturian.Http.Router).route .get (.exact "/health")
    (fun _head _reader writer => do
      Server.Stream.respond writer
        { status := 200, reason := "OK",
          headers := #[("content-type", Zenturian.Http.jsonContentType)] }
        "{\"service\":\"zenturian-lean\",\"status\":\"ok\"}".toUTF8)

/-- Bind, report the socket, and serve until the runtime ends or the process is terminated. Returns
the accept loop's outcome: a clean stop is `.ok`, a transport failure is the error. -/
def serve (opts : Options) : IO (Except IO.Error Unit) := do
  let hooks ← Runtime.Hooks.new
  let listener ← Runtime.Listener.bind (Runtime.loopback opts.port)
  let addr ← Runtime.Listener.sockName listener
  let workers := max 1 opts.workers
  let executor ← Sched.Executor.new LeanIn.Task.Item 256 workers
  let cfg : Server.Config :=
    { h1 := { maxBody := 1073741824 }
      clock := Runtime.Clock.live hooks
      stallTimeout := 12000 }
  IO.println s!"listening on {addr}"
  (← IO.getStdout).flush
  let table : Zenturian.Http.Router := routes
  let body : Runtime.Conn → LeanIn.Task.EAsync IO.Error Unit :=
    fun c => Server.serveConnStream cfg c table.serve
  let (_, outcome) ← Runtime.runCarriersWait executor workers
    (Runtime.serveForeverShared hooks executor listener body)
  Runtime.Io.stop
  return outcome

end Zenturian.App
