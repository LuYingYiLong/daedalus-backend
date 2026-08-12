export const MIN_BRIDGE_PROTOCOL_VERSION = 4;
export const MAX_BRIDGE_PROTOCOL_VERSION = 4;

export function isBridgeProtocolSupported(protocolVersion: number | undefined): boolean {
	return protocolVersion !== undefined
		&& protocolVersion >= MIN_BRIDGE_PROTOCOL_VERSION
		&& protocolVersion <= MAX_BRIDGE_PROTOCOL_VERSION;
}
