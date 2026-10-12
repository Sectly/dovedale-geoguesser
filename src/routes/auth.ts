import { Hono } from "hono";
import { DEV_MODE, GAME } from "../config";
import { consumeState, createAuthUrl, exchangeCode, oauthConfigured } from "../auth/discord";
import {
	clearedSessionCookie,
	createSession,
	hasAccount,
	currentUser,
	deleteSession,
	redirectCookie,
	sessionCookie,
	sessionIdFromCookies,
	stateCookie,
	upsertDevUser,
	upsertUser,
	welcomeCookie,
} from "../auth/sessions";
import { auditLog } from "../lib/audit";
import { clientIp, getCookie, safeRedirect } from "../lib/http";
import { checkRateLimit } from "../lib/rate-limit";
import { displayName, notify } from "../lib/webhook";
import { activeBanReason } from "../moderation";
import { hasRole, isStaff } from "../auth/guards";
import { publicPreferences } from "../notifications";
import { features } from "../system/features";
import { maintenance } from "../system/maintenance";
import { errorPage } from "./pages";

export const authRoutes = new Hono();

authRoutes.get("/login", (c) => {
	if (!checkRateLimit(`login:${clientIp(c)}`, 10, 15 * 60 * 1000))
		return errorPage(c, {
			status: 429,
			title: "Too many login attempts",
			message: "Give it fifteen minutes, then try logging in again.",
		});
	const redirect = safeRedirect(c.req.query("redirect"));

	if (DEV_MODE) {
		c.header("Set-Cookie", sessionCookie(createSession(upsertDevUser())), { append: true });
		c.header("Set-Cookie", welcomeCookie("back"), { append: true });
		return c.redirect(redirect);
	}
	if (!oauthConfigured())
		return errorPage(c, {
			status: 503,
			title: "Login is unavailable",
			message: "Discord login is not set up on this server.",
		});

	const { url, state } = createAuthUrl();
	c.header("Set-Cookie", redirectCookie(redirect), { append: true });
	c.header("Set-Cookie", stateCookie(state), { append: true });
	return c.redirect(url);
});

authRoutes.get("/callback", async (c) => {
	if (DEV_MODE) return c.redirect("/");

	const code = c.req.query("code");
	const state = c.req.query("state");
	/** Declining on Discord's consent screen lands here; just send the player home. */
	if (c.req.query("error")) return c.redirect("/");
	if (!code || !state)
		return errorPage(c, {
			status: 400,
			title: "Login didn't finish",
			message: "Discord sent you back without the details we need. Please try logging in again.",
		});
	/** The login must come back to the browser it started in, and each state works once. */
	const started = getCookie(c.req.header("Cookie"), "oauth_state");
	c.header("Set-Cookie", stateCookie(null), { append: true });
	if (started !== state || !consumeState(state))
		return errorPage(c, {
			status: 400,
			title: "Login link expired",
			message: "That took a little too long. Please try logging in again.",
		});

	try {
		const profile = await exchangeCode(code);
		if (!features().signups && !hasAccount(profile.discord_id))
			return errorPage(c, {
				status: 403,
				title: "New accounts are paused",
				message: "We aren't taking new accounts right now. Please come back later.",
				help: false,
			});
		const { id: userId, isNew } = upsertUser(profile);
		if (isNew)
			notify(
				"users",
				`**New user registered**: **${displayName(profile)}** (@${profile.username})`,
				"/admin#users"
			);
		auditLog(null, isNew ? "user_register" : "user_login", {
			targetType: "user",
			targetId: userId,
			targetUsername: profile.username,
		});

		const redirect = safeRedirect(getCookie(c.req.header("Cookie"), "oauth_redirect"));
		c.header("Set-Cookie", sessionCookie(createSession(userId)), { append: true });
		c.header("Set-Cookie", redirectCookie(null), { append: true });
		c.header("Set-Cookie", welcomeCookie(isNew ? "new" : "back"), { append: true });
		return c.redirect(redirect);
	} catch (err) {
		console.error("OAuth callback error:", err);
		return errorPage(c, {
			status: 503,
			title: "Couldn't log you in",
			message: "We couldn't reach Discord to confirm who you are. Please try again in a moment.",
		});
	}
});

authRoutes.get("/me", (c) => {
	const user = currentUser(c);
	/** Being logged out is a normal answer here, not an error. */
	if (!user) return c.json(null);
	return c.json({
		id: user.id,
		discord_id: user.discord_id,
		username: user.username,
		display_name: user.display_name,
		avatar_url: user.avatar_url,
		role: isStaff(user) ? user.role : null,
		staff_locked: !!user.staff_locked && !!user.role,
		is_banned: !!user.is_banned,
		ban_type: user.is_banned ? user.ban_type : null,
		ban_expires_at: user.is_banned ? user.ban_expires_at : null,
		ban_reason: user.is_banned ? activeBanReason(user.id) : null,
		upload_limited: !!user.upload_limited,
		duel_limited: !!user.duel_limited,
		profile_private: !!user.profile_private,
		duel_rating: user.duel_rating ?? GAME.rating.start,
		duel_rated_games: user.duel_rated_games ?? 0,
		suggestions_agreed: !!user.suggestions_agreed,
		prefs: publicPreferences(user),
		/** Only staff ever see the site during maintenance, so only they need telling. */
		maintenance: hasRole(user, "moderator") && maintenance().enabled ? maintenance().message || true : false,
	});
});

authRoutes.get("/logout", (c) => {
	const sessionId = sessionIdFromCookies(c.req.header("Cookie"));
	if (sessionId) deleteSession(sessionId);
	c.header("Set-Cookie", clearedSessionCookie());
	return c.redirect("/");
});
