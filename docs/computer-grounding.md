# Icon grounding for authorized Windows windows

The input profile remains **UIA + restricted keyboard**. Visual boxes are evidence, not coordinates that can be clicked. No mouse, touch, detector weights, or additional runtime dependencies are introduced.

## Availability and flow

The Backend advertises `client.info.features.computerGrounding: 1`. A compatible Windows Studio checks this before sending `computerGrounding` in `client.capabilities.update`; the first hello does not contain the new field. The observation setting and live Main/helper availability remain required. Remote, Android, Goal, and scheduled runs never receive the tool. Backend protocol 3, native protocol 3, and `computerControl: 3` are unchanged.

1. Request observation or control consent for the current canonical user turn.
2. Use `mcp_computer_observe`; prefer its actual UIA nodes and OCR evidence.
3. If a visible icon cannot be identified, call `mcp_computer_locate` with `observationId`, a precise `target`, and optionally `uiaAction` (default `uia_invoke`).
4. Only an unambiguous `matched` result can supply a UIA node for `mcp_computer_action`. Include the returned `groundingId`, the same observation, node, and action type.
5. Observe again to verify application effects. Dispatch success is not proof that the application changed as intended.

After a frame has been used for grounding, a UIA action without a grounding receipt is also rejected. Ambiguous, visual-only, not-found, failed, or stale grounding must not be worked around by omitting the receipt or replaying an uncertain action. Ordinary UIA actions on frames that did not use grounding keep their existing contract. Observation consent never grants input: upgrading to control invalidates the old frame/grounding and requires a new observation.

## Model and matching

The configured `imageRecognition` model is used when present; otherwise the current model must support images. An unusable configured route produces an explicit error, not a provider fallback. Each locate call permits one model request, with a 60-second model-stage deadline and no automatic retry. The ordinary tool budget and provider usage/trace accounting still apply.

The model receives the exact prepared PNG, its real dimensions, the target, and bounded geometry-only UIA hints. It receives no tools. English system instructions require JSON in original `image_pixels`, at most five boxes, and at most 16 KiB of response text. Finite numbers, positive dimensions, bounds, fields, and text lengths are validated. No normalized-coordinate guessing, JSON repair, coordinate clipping, model-supplied node IDs, or confidence-based authorization is allowed.

Code matches each visual box against enabled, non-password UIA nodes supporting the requested action. The center must lie inside the node and at least 80% of the visual box must be covered. Exactly one candidate and one eligible node yields `matched`. Multiple plausible boxes/nodes yield `ambiguous`; no actionable node yields `visual_only`; no visual candidate yields `not_found`.

## Lifecycle and persistence

`grounding.prepare` and `grounding.validate` are internal Studio forwarding operations, not LLM tools. Main returns the existing frame and generation, then revalidates them after inference without recapturing. Model waiting does not hold the native observation queue or block heartbeats. Receipts bind the connection, session, canonical turn, run, generation, observation, node, and action.

New observation, input, pause, permission change, revocation, disconnection, and terminal run events invalidate pending work/receipts. Cancellation aborts the visual request; late results cannot commit or execute. Calls are serialized per session and deduplicated by tool-call identity.

SQLite schema 11 adds `computer_observations.groundings_json`, separate from immutable `detail_json`. Up to ten locate results can be saved per frame. The same PNG blob is reused, never inserted into event/trace JSON. Grounding text is redacted before persistence; tool logs carry only structural summaries. Grounding bodies and PNGs are cleared by the existing ten-completed-turn compaction transaction. Developer mode off and compacted evidence expose summaries only. Studio's evidence inspector adds a Visual grounding tab; selecting a candidate only highlights the saved image. Local diagnostics remain offline.

## Verification

Backend unit/integration tests use fixed frames and mocked providers/transports. Studio tests use real Electron with a Mock Backend and helper; they do not access user windows or real models. These tests validate matching, boundaries, cancellation, persistence, capability negotiation, and UI rendering—not a vision model's accuracy.

Before practical use, test the configured vision model on a dedicated non-sensitive icon-only window, in light/dark themes and at 100%/150%/200% scaling. Record the predicted box, matched UIA node, and observed application result. Self-drawn interfaces without accessible UIA controls remain non-actionable.
