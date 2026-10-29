# Architecture vocabulary

Use the project's established names; these definitions help compare designs without forbidding ordinary engineering language.

- Module: a unit with an interface and implementation.
- Interface: what callers must know, including types, invariants, ordering, errors, and relevant performance behavior.
- Depth: meaningful behavior hidden behind a manageable interface, not a ratio of code lines.
- Seam: a place where behavior can be substituted or varied without editing its consumers.
- Adapter: a concrete implementation at such a seam.
- Locality: related changes, knowledge, and verification concentrated together.

The deletion test asks whether removing an abstraction removes unnecessary complexity or merely redistributes necessary behavior among callers. Prefer test surfaces that express observable behavior. A test adapter can justify a seam, but an arbitrary adapter count neither proves nor disproves a good boundary.
