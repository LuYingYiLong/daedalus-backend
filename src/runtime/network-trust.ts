import {
	getCACertificates,
	setDefaultCACertificates
} from "node:tls";

export type CertificateTrustConfiguration = {
	configured: boolean;
	defaultCertificateCount: number;
	systemCertificateCount: number;
	totalCertificateCount: number;
	error: string | null;
};

type TlsCertificateApi = {
	getCACertificates(type: "default" | "system"): string[];
	setDefaultCACertificates(certificates: readonly string[]): void;
};

const nodeTlsCertificateApi: TlsCertificateApi = {
	getCACertificates,
	setDefaultCACertificates
};

let currentConfiguration: CertificateTrustConfiguration | null = null;

export function mergeCertificateAuthorities(
	defaultCertificates: readonly string[],
	systemCertificates: readonly string[]
): string[] {
	return [...new Set([...defaultCertificates, ...systemCertificates])];
}

export function configureSystemCertificateTrust(
	api: TlsCertificateApi = nodeTlsCertificateApi
): CertificateTrustConfiguration {
	if (api === nodeTlsCertificateApi && currentConfiguration !== null) {
		return currentConfiguration;
	}
	let result: CertificateTrustConfiguration;
	try {
		const defaultCertificates: string[] = api.getCACertificates("default");
		const systemCertificates: string[] = api.getCACertificates("system");
		const mergedCertificates: string[] = mergeCertificateAuthorities(
			defaultCertificates,
			systemCertificates
		);
		api.setDefaultCACertificates(mergedCertificates);
		result = {
			configured: true,
			defaultCertificateCount: defaultCertificates.length,
			systemCertificateCount: systemCertificates.length,
			totalCertificateCount: mergedCertificates.length,
			error: null
		};
	} catch (error: unknown) {
		result = {
			configured: false,
			defaultCertificateCount: 0,
			systemCertificateCount: 0,
			totalCertificateCount: 0,
			error: error instanceof Error ? error.message : String(error)
		};
	}
	if (api === nodeTlsCertificateApi) {
		currentConfiguration = result;
	}
	return result;
}
