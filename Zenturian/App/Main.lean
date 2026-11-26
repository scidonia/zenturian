import Zenturian.App.Server

/-!
# `zenturianLean`

Argument parsing and subcommand dispatch. `health` is the only subcommand this item serves; the
server it starts binds loopback, prints the address it took, and answers the health probe.
-/

open Zenturian.App

def usage : String := "usage: zenturianLean health [--port <n>] [--workers <n>]"

/-- Parse the options `health` accepts. An unknown option, a missing value or a number out of range
is a loud failure with the usage line, not a silent default. -/
partial def parseOptions : List String → Except String Options
  | [] => .ok {}
  | "--port" :: value :: rest =>
    match value.toNat? with
    | none => .error s!"--port expects a number, got \"{value}\""
    | some n =>
      if n > 65535 then
        .error s!"--port must be 0..65535, got {n}"
      else
        (parseOptions rest).map fun opts => { opts with port := n.toUInt16 }
  | ["--port"] => .error "--port expects a value"
  | "--workers" :: value :: rest =>
    match value.toNat? with
    | none => .error s!"--workers expects a number, got \"{value}\""
    | some n =>
      if n == 0 then
        .error "--workers must be at least 1"
      else
        (parseOptions rest).map fun opts => { opts with workers := n }
  | ["--workers"] => .error "--workers expects a value"
  | flag :: _ => .error s!"unknown option \"{flag}\""

def main (args : List String) : IO UInt32 := do
  match args with
  | "health" :: rest =>
    match parseOptions rest with
    | .error message =>
      IO.eprintln s!"zenturianLean: {message}"
      IO.eprintln usage
      return 2
    | .ok opts =>
      match ← serve opts with
      | .ok _ => return 0
      | .error err =>
        IO.eprintln s!"zenturianLean: {err}"
        return 1
  | _ =>
    IO.eprintln usage
    return 2
