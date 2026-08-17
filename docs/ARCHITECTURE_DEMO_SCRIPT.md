# ManyVue: Convex architecture and opportunity scripts

## Convex architecture view — technical 15-second script

> "Convex is ManyVue's authoritative distributed control plane: it capability-authenticates every camera, leases live presence, commits revisioned server-timed scenes, and reactively synchronizes every screen without polling. For each Burst, Convex snapshots eligible recorders, privately fans out the immutable T-minus-three to T-plus-three anchor, and verifies every media upload, asset, and personalized result back to its real participant."

## Convex architecture view - technical 30-second script

> "Convex is ManyVue's distributed coordination layer. Every device joins through a capability-guarded identity, heartbeats a sequenced presence lease, and subscribes to an authoritative revisioned scene. A director mutation validates active camera membership, normalizes the server-timed cut, atomically commits the next revision, and reactively fans it to every screen without polling. A Burst uses a separate protected query: Convex snapshots eligible recorders, persists an immutable T-minus-three to T-plus-three anchor, deduplicates markers and assets, and tracks preserved, uploaded, and owner-scoped readiness."

## Deeper technical continuation

> "The data model is an auditable state machine across sessions, participants, scenes, Bursts, contributions, assets, and render jobs. Client sequence numbers reject out-of-order heartbeats; idempotency keys make scene, asset, and render retries safe; indexed queries keep the hot paths bounded; and a scheduled expiry mutation removes stale camera leases without letting old offline rows starve active presence. Server-side authorization queries also bind room credentials, Burst uploads, and expiring media reads to the same hashed capabilities. Reconnecting clients simply resubscribe and converge on the current authoritative revision."

## What to point at while speaking

1. Point to `participants` and say: "capability-guarded identity and sequenced presence lease."
2. Move to `scenes` and trace `scheduleScene -> revision -> cutAtServerMs -> programState`.
3. Move to the protected Burst channel and trace `expected cameras -> immutable capture anchor -> contributions`.
4. Finish on `assets` and `renderJobs` while saying: "idempotent provenance, readiness, and ownership."
5. Sweep across the subscription arrows on: "every client converges without polling."

## Strong closing line

> "Convex is not storage behind the demo; it is the transactional state machine that makes independently connected phones behave like one fault-tolerant production system."

## Transition to the product opportunity PDF

> "That coordination layer is reusable festival infrastructure. The same presence, scene, capture, and ownership primitives can power personal multi-angle memories, artist-controlled crowd media, real visual windows into every stage, and remote viewing from perspectives fixed cameras cannot provide."

## While showing the roadmap section

> "The working system already proves the state model end to end. A festival pilot hardens the same primitives with adaptive quality, offline recovery, rights enforcement, and higher concurrency; the platform layer then adds official stage discovery, artist-triggered capture, crowd-powered broadcasts, and automatically rendered personal films without redesigning the realtime core."

## One-line judge takeaway

> "Convex is the authoritative, reactive state machine that turns a crowd of unreliable mobile clients into one coherent production."
