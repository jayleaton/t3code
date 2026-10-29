# Refactoring boundaries and tests

Identify the behavior to consolidate and its consumers before merging modules. In-process code can often be tested directly. Local services may have useful test substitutes; verify the substitute covers semantics the change relies on. Owned remote services and third-party dependencies may need explicit contracts and adapters, with contract/integration tests where mocks cannot establish compatibility.

Do not introduce ports merely to wrap every dependency, or assume in-memory substitutes behave exactly like production. Preserve relevant error, concurrency, timing, and transactional behavior. Keep internal testing seams private unless callers actually need them.

Migrate incrementally when compatibility matters. Tests should cover the observable contract and real failure patterns. Remove old tests only after checking their coverage is redundant or no longer relevant; a deeper abstraction does not automatically make lower-level tests worthless.

Validate the original use cases through the new interface and inspect whether the change actually reduces scattered knowledge and coupling.
