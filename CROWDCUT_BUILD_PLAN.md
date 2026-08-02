# CrowdCut Live — Canonical Build Plan

This is the source of truth for every implementation and review agent. Do not silently reduce scope, fake media, simulate participants, or claim integrations that are not wired and verified.

## Product lock

**One sentence:** CrowdCut Live turns the phones already recording a concert moment into one AI-directed camera crew: every fan keeps their original clip, sees when their angle enters the live production, taps Burst on the exact moment they want to preserve, and receives a cinematic multi-perspective film made from the real crowd around them.

**Attendee promise:** Record your angle. See it go live. Take home the crowd.

## Demo topology

- The laptop plays the master soundtrack and drives the projector/big-screen Program View.
- The presenter's phone joins through the same QR code as everyone else and is a genuine selectable camera.
- The laptop webcam and one spare phone provide two real seed angles.
- Three to eight attendees can join during the demo; preflight target is ten concurrent publishers.
- Phone audio is muted in the live Program View to avoid echo. The laptop soundtrack is the continuous production audio.
- No second operator, prerecorded angle, simulated participant, fake result, or illustrative evidence.

## Four core experiences

### 1. Start My Angle

- Persistent QR opens the attendee camera directly.
- No account, profile, feed, lobby, or tutorial.
- One `START MY ANGLE` control begins local high-quality recording and publishes a lower-bandwidth live camera track.
- Original recording is retained locally and durably queued for upload.
- Selected device receives a visible `YOUR ANGLE IS LIVE` border; compatible devices may also vibrate.

### 2. Live Crowd Director

- The shared screen is one film, never a surveillance grid.
- Three intentional scene recipes only:
  - **Hero:** one full-screen angle.
  - **Duo:** performer angle plus a complementary side, wide, or reaction view.
  - **Sweep:** several full-screen angles in rhythmic sequence.
- Deterministic checks reject dark, frozen, blurred, covered, duplicate, or disconnected views.
- OpenAI vision labels viable views (hero, wide, side, reaction, moving) and proposes the next scene recipe.
- Convex commits the authoritative recipe with `activeCameraIds`, `layout`, `cutAtServerMs`, and `revision` so the Program View and participant state change together.
- Manual keyboard controls remain a real safety mechanism, never hidden prerecorded choreography.

### 3. Burst This Moment

- Every recording attendee independently receives one large `BURST THIS MOMENT` control.
- A tap marks the attendee's chosen instant on the shared Convex timeline; there is no countdown.
- Every active device is already maintaining a rolling segmented recording, so the product preserves approximately two seconds before and three seconds after the marker.
- Nearby taps are clustered into one shared moment to prevent production spam, while each initiator retains a personalized ordering.
- The triggering phone shows `CROWD BURST CAUGHT` and the live screen produces a rapid, full-screen, real-perspective preview as contributions arrive.
- Claims are truthful: same musical cue from different positions, not guaranteed identical frames or invented 3D motion.

### 4. My CrowdCut

- Primary shareable artifact is an 8–12 second vertical MP4 centered on the attendee's selected Burst.
- Opens on the owner's angle, moves through complementary real views, includes the Burst sweep and selected-live moment, and returns to the owner.
- Uses clean master audio with controlled owner/crowd ambience.
- OpenAI returns a structured edit recipe: source ordering, timing, shot roles, vertical crop/focus, and transitions.
- A production renderer creates the real video from uploaded source clips. AI creates the edit, not the event.
- The full original recording remains separately available to its owner.
- JamBase metadata may label the artist, festival, stage, and set when a real API key is configured.

## System boundaries

### ChatGPT Sites

- Hosts the attendee camera, Program View, director controls, artifact viewer, and Festival Now surface.
- Capability-path project; Cloudflare Worker-compatible output.
- `.openai/hosting.json` is authoritative for Sites resources and deployment.

### Convex — authoritative experience/control plane

- Sessions and anonymous capability tokens.
- Presence, connection state, and recording intervals.
- Active cameras, scheduled scene recipes, current/next selection, and director timeline.
- Burst markers, clustered moments, device acknowledgements, contribution arrivals, and deadlines.
- Asset metadata, upload reconciliation, render jobs, retries, and reactive completion.
- Convex never transports raw live video bytes.

### Live media plane

- LiveKit Cloud SFU/TURN for real camera tracks.
- Each phone publishes one video track; Program View subscribes to low-resolution layers for analysis and higher quality for selected sources.
- Local `MediaRecorder` saves full-quality source chunks to IndexedDB through connectivity loss.
- Offline phones leave the live film but continue local capture and reconcile after reconnect.

### AI director

- OpenAI Responses API with current supported vision-capable model; default resolved target is `gpt-5.6-sol` unless latency testing requires a documented faster current model.
- Low-resolution labeled contact sheets only; never uploads or fabricates unnecessary full-resolution media.
- Live AI is advisory and precomputed ahead of cuts. Deterministic scoring continues on timeout.
- Post-capture edit recipe is schema-validated before rendering.

### Rendering

- Production Shotstack render API is the primary renderer; no sandbox watermark.
- Inputs: owner clip, recorded Program View/timeline, Burst clips/frames, master soundtrack, metadata.
- Webhook updates Convex idempotently.
- Immediate in-app Burst preview and final production MP4 are distinct truthful states.

## Festival Now bonus

- JamBase supplies real festival, artist, stage, and set identity.
- Active stages show a muted low-bandwidth living CrowdCut window and `LIVE · N ANGLES`.
- No fake attendance estimate, generic heatmap, or continuous GPS requirement.
- Stage QR/session identity is primary; optional coarse location may only assist stage selection.

## Mobile and UX rules

- Camera-first visual design; controls never cover the subject.
- Persistent small QR on Program View.
- Strong electric-gold live border is the universal selected-state signal; vibration is enhancement-only.
- Permission denial, unsupported codec, lost connection, queued upload, and render failure are explicit states.
- Use `MediaRecorder.isTypeSupported` and transcode mixed source formats in rendering.
- Touch targets remain usable one-handed; orientation changes must not corrupt recording.

## Non-negotiable acceptance gates

- Camera publishes within 5 seconds after permission on the target network.
- Ten concurrent publishers survive preflight; at least three physical phones work in the live demo.
- Program cut and selected-phone `LIVE` state differ by no more than 300 ms.
- Covered/frozen active camera fails over within 1.5 seconds.
- Tested Burst marker spread stays below 250 ms.
- At least three Burst contributions reveal within 3 seconds.
- A 10-second network loss does not corrupt local recording.
- Lost camera exits Program View and automatically becomes eligible after reconnect.
- Two distinct 8–12 second vertical MP4s render within 30 seconds after required uploads complete.
- Duplicate mutations and render webhooks are idempotent.
- No placeholder media, simulated user, hardcoded result, swallowed failure, or claim without a real artifact.

## Verification matrix

- Unit tests: scene scheduling, Burst clustering, idempotency, authorization, upload reconciliation, render workflow.
- Integration: Convex subscriptions, LiveKit token path, OpenAI recipe schema, Shotstack webhook.
- Browser: latest Chrome/Android and Safari/iPhone permission, recording, rotation, background/foreground, and codec behavior.
- Network: late join, high latency, packet loss, 10-second disconnect, reconnect, partial upload, duplicate webhook.
- Real deployed HTTPS test with real phones, timestamped logs, screenshots, recordings, and finished MP4s.

## Parallel work ownership

- **Lane A — realtime/backend:** Convex schema, session APIs, scheduled scene state, Burst clustering, workflows, tests.
- **Lane B — live media:** LiveKit token/publishing/subscription, camera UI, Program View, layouts, local recording/reconnect.
- **Lane C — artifacts/AI:** OpenAI director/edit schema, Burst assembly, renderer adapter/webhook, Festival Now metadata.
- **Root integrator:** Sites foundation, canonical UX/design, shared contracts, dependency integration, E2E, deployment, and ruthless review.

Agents must read this file before editing. Assign non-overlapping files where possible. Report partial work honestly. Never overwrite another lane's changes.

## Required production access

- `CONVEX_DEPLOYMENT` and public Convex URL.
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- `OPENAI_API_KEY`.
- `SHOTSTACK_API_KEY` with production rendering.
- `JAMBASE_API_KEY` for Festival Now.
- ChatGPT Sites project and production environment values.

Local/demo mode must remain explicit when any production credential is missing; it must never masquerade as the fully wired path.
