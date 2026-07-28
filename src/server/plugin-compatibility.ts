export const MIN_PLUGIN_PROTOCOL_VERSION = 1;
export const MAX_PLUGIN_PROTOCOL_VERSION = 2;

export function isPluginProtocolSupported(protocolVersion: number | undefined): boolean {
	return protocolVersion === undefined
		|| (protocolVersion >= MIN_PLUGIN_PROTOCOL_VERSION && protocolVersion <= MAX_PLUGIN_PROTOCOL_VERSION);
}
