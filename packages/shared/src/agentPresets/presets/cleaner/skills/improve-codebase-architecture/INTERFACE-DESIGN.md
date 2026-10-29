# Compare interface designs

For a concrete module, state its callers, behavior, dependencies, and invariants. Compare a small number of meaningfully different designs: a minimal interface, one optimized for the common caller, and a more flexible alternative if the use cases justify it.

For each, show types/entry points, usage, error and ordering behavior, hidden complexity, test seam, migration path, and tradeoffs. Use the dependency categories in [DEEPENING.md](DEEPENING.md) where useful. Prefer the design that concentrates real complexity while keeping common operations understandable.

Do not require multiple agents or a particular unavailable agent tool. Independent evaluation is optional when authorized and useful; the same comparison can be done locally. Recommend a design based on actual caller needs rather than an arbitrary method-count limit.
