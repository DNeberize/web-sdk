import type { paths } from './schema';
import { fetcher } from 'utils-fetcher';

// rgs_url normally comes without a protocol (Stake Engine). An explicit http:// or https://
// is kept as-is so a local mock RGS (tools/mock-rgs) can run over plain http.
const toEndpoint = (rgsUrl: string, url: string) =>
	`${/^https?:\/\//.test(rgsUrl) ? rgsUrl.replace(/\/+$/, '') : `https://${rgsUrl}`}${url}`;

export const rgsFetcher = {
	post: async function post<
		T extends keyof paths,
		TResponse = paths[T]['post']['responses'][200]['content']['application/json'],
	>(options: {
		url: T;
		rgsUrl: string;
		variables?: paths[T]['post']['requestBody']['content']['application/json'];
	}): Promise<TResponse> {
		const response = await fetcher({
			method: 'POST',
			variables: options.variables,
			endpoint: toEndpoint(options.rgsUrl, options.url),
		});

		if (response.status !== 200) console.error('error', response);
		const data = await response.json();
		return data as TResponse;
	},
	get: async function get<
		T extends keyof paths,
		TResponse = paths[T]['get']['responses'][200]['content']['application/json'],
	>(options: { url: T; rgsUrl: string }): Promise<TResponse> {
		const response = await fetcher({
			method: 'GET',
			endpoint: toEndpoint(options.rgsUrl, options.url),
		});

		if (response.status !== 200) console.error('error', response);
		const data = await response.json();
		return data as TResponse;
	},
};
