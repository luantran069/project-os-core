# Agent roles

Each role is a contract: one job, defined inputs and outputs, and a list of
actions the role must never take. A project enables roles through the modules in
`project.yaml`. In core v0 only `coder` runs unattended (through Symphony); the
other roles are written down so they can be enabled one at a time.

Every role file uses the same sections:

- **Job**: the single outcome the role owns.
- **Reads**: what it must read before acting. Every role reads `memory/vision.md` first.
- **Produces**: the artifact it hands off, and where it is stored.
- **Gate**: the human gate its output waits at, if any.
- **Never**: actions outside the role's authority.

| Role                        | Module    | Gate | Runs in v0    |
| --------------------------- | --------- | ---- | ------------- |
| [strategist](strategist.md) | assess    | G1   | Manual prompt |
| [planner](planner.md)       | build     | G2   | Manual prompt |
| [coder](coder.md)           | build     | —    | Symphony      |
| [reviewer](reviewer.md)     | build     | —    | Inside coder  |
| [release](release.md)       | deploy    | G3   | Not yet       |
| [marketer](marketer.md)     | marketing | G4   | Not yet       |
| [analyst](analyst.md)       | analytics | —    | Not yet       |
| [librarian](librarian.md)   | memory    | —    | Not yet       |
