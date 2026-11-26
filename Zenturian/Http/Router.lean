import LeanIn
import LeanIn.Http.Server
import LeanIn.Http.H1

/-!
# The route table

The server is LeanIn's: this module is the ordered table its streaming handler consults. A route
matches on the request method and the request target (`H1.Head.targetString?`) — exactly, or by
prefix — and the first match answers; no match answers `404`.

Dispatch is on the parsed head alone. The matched route owns its body: it reads through the
`BodyReader` LeanIn hands it, or ignores it, in which case the connection is closed after the
response rather than reused. The shared capped reader belongs to the routes that read a body, not
to the table.

There is no router framework here on purpose: the table is an `Array` walked in order, and later
items extend it with `Router.route` rather than another mechanism. Each handler receives the body
reader and the response writer LeanIn's driver hands it, so it reads its own body and writes its
own head.
-/

namespace Zenturian.Http

open LeanIn
open LeanIn.Http

def jsonContentType : String := "application/json; charset=utf-8"

/-- How a route's target is compared with the request target. -/
inductive TargetMatch where
  /-- The target must equal the path, query string included. -/
  | exact (path : String)
  /-- The target must start with the path. -/
  | prefix (path : String)
deriving Inhabited, BEq

def TargetMatch.matches (m : TargetMatch) (target : String) : Bool :=
  match m with
  | .exact path => target == path
  | .prefix path => path.isPrefixOf target

structure Route where
  method : H1.Method
  target : TargetMatch
  handler : Server.StreamHandler

structure Router where
  routes : Array Route := #[]

/-- Append a route. The table is ordered, so a more specific route is added before the prefix that
would also match it. -/
def Router.route (r : Router) (method : H1.Method) (target : TargetMatch)
    (handler : Server.StreamHandler) : Router :=
  { r with routes := r.routes.push { method, target, handler } }

/-- The first route whose method and target match, or `none`. An unparsable target matches nothing. -/
def Router.find (r : Router) (head : H1.Head) : Option Server.StreamHandler :=
  match head.targetString? with
  | none => none
  | some target =>
    r.routes.foldl
      (fun found route =>
        found.orElse fun _ =>
          if route.method == head.method && route.target.matches target then
            some route.handler
          else
            none)
      (none : Option Server.StreamHandler)

def notFoundBody : ByteArray :=
  "{\"error\":{\"code\":\"not_found\",\"message\":\"no route for this request\"}}".toUTF8

/-- The streaming handler: dispatch the ordered table on the request head. -/
def Router.serve (r : Router) : Server.StreamHandler :=
  fun head reader writer =>
    match r.find head with
    | some handler => handler head reader writer
    | none =>
      Server.Stream.respond writer
        { status := 404, reason := "Not Found",
          headers := #[("content-type", jsonContentType)] }
        notFoundBody

end Zenturian.Http
