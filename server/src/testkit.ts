/**
 * The backend's testable surface.
 *
 * The server ships as one bundled entry point with no exports, which is right
 * for a program and useless for testing a wire protocol: `dist/server.js`
 * starts listening the moment it is imported.
 *
 * Most of this project's tests spawn that real process and talk to it, which
 * is the honest way to test a bridge. The Cast protocol is the exception —
 * every interesting case (a device already showing the dashboard, a receiver
 * that takes its time registering its channel, a display that is switched
 * off) is a property of one short conversation, and driving those through a
 * whole server process would test the timer rather than the protocol.
 *
 * So this second, tiny bundle exposes exactly the pieces worth exercising
 * directly. It is a build artefact like `dist/server.js` and ships nowhere:
 * the container's entry point is unchanged.
 */

export { encodeFrame, decodeFrame, FrameReader } from '~/cast/protocol.ts';
export type { CastFrame } from '~/cast/protocol.ts';
export { CastDevice, DASHCAST_APP_ID } from '~/cast/device.ts';
export type { CastOutcome, CastTransport } from '~/cast/device.ts';
export { CastKeeper, splitHost } from '~/cast/keeper.ts';
export type { VisitResult } from '~/cast/keeper.ts';

/*
 * The webOS client, for the same reason as the Cast pieces above: every case
 * worth testing (a pairing prompt nobody has accepted yet, a stored key being
 * reused, a refusal that arrives dressed as a success, a television that is
 * simply off) is a property of one short conversation with a device.
 */
export { WebosClient } from '~/tv/webos.ts';
export { failureOf, inputsOf } from '~/tv/protocol.ts';
export { magicPacket, parseMac } from '~/tv/wol.ts';
