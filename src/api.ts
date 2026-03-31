const IDP = "https://idp.kiltergrips.com";
const API = "https://portal.kiltergrips.com/api";

export async function getToken(
	username: string,
	password: string,
): Promise<string> {
	const res = await fetch(
		`${IDP}/realms/kilter/protocol/openid-connect/token`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "password",
				client_id: "kilter",
				scope: "openid offline_access",
				username,
				password,
			}),
		},
	);
	if (!res.ok)
		throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
	return (await res.json()).access_token;
}

export function getUserUuid(token: string): string {
	const parts = token.split(".");
	if (parts.length < 2) throw new Error("Invalid token format");
	const payload = JSON.parse(atob(parts[1]));
	if (!payload.sub) throw new Error("Token missing user ID");
	return payload.sub;
}

async function parseBody(res: Response): Promise<unknown> {
	try {
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	} catch {
		return null;
	}
}

export async function apiPost(
	token: string,
	path: string,
	body: unknown,
): Promise<{ status: number; data: unknown }> {
	const res = await fetch(`${API}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
	});
	return { status: res.status, data: await parseBody(res) };
}

export async function apiGet(token: string, path: string): Promise<unknown> {
	const res = await fetch(`${API}${path}`, {
		method: "GET",
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	return parseBody(res);
}

export function toISODate(s: string): string {
	return `${s.replace(" ", "T")}Z`;
}
