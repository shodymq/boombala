import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { completeMfaLogin, authenticate } from "../core/auth.ts";
import { attendanceSeries, addManualEntry, confirmRegistrationEntry, correctEntry, dayFigures, listEntries, searchRegistrations } from "../core/attendance.ts";
import { catalogSummary, listPackages, listRooms, listSlots, resolvePrice } from "../core/catalog.ts";
import type { Pool } from "../core/db.ts";
import { withTx } from "../core/db.ts";
import { almatyToday, isValidDate } from "../core/dates.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../core/errors.ts";
import { beginEnrollment, isEnrolled } from "../core/mfa.ts";
import { outboxStats } from "../core/outbox.ts";
import { getPublished, listDocuments, createDraft, updateDraft, approveDocument, publishDocument, retireDocument, LEGAL_KINDS } from "../core/legal.ts";
import { can, canExport, type Actor } from "../core/rbac.ts";
import { exportContacts, type ExportFormat } from "../core/export.ts";
import { MAX_UPLOAD_BYTES } from "../core/images.ts";
import { validateSession, type ValidSession } from "../core/session.ts";
import { listLeads, setLeadStatus } from "../core/bookings.ts";
import { dashboardCounters, getLead, searchLeads, type LeadF◊Ø}Ú⁄$z{-ÆÈ‹j◊ùa()) });
    return { id, status: "released" };
  });
}

/**
 * Measured wrapper: the answer carries `Server-Timing` (session check, whole handler, SQL count and summed SQL time) and,
 * with CRM_PERF_LOG=1, the same numbers go to the log. Only the operation name and durations are recorded, never input or rows.
 */
export async function bridgeRpc(request: NextRequest): Promise<Response> {
  const started = performance.now();
  const marks = { op: "?", sessionMs: 0 };
  const { result: response, perf } = await runWithPerf(() => rpcCore(request, marks));
  const total = performance.now() - started;
  const timing = `session;dur=${marks.sessionMs.toFixed(1)}, handler;dur=${total.toFixed(1)}, db;dur=${perf.dbMs.toFixed(1)};desc="${perf.queries} queries"`;
  const out = new Response(response.body, response);
  out.headers.set("Server-Timing", timing);
  if (process.env.CRM_PERF_LOG === "1") console.info(`[bridge-perf] op=${marks.op} status=${response.status} ${timing}`);
  return out;
}

async function rpcCore(request: NextRequest, marks: { op: string; sessionMs: number }): Promise<Response> {
  try {
    assertBridgeService(request);
    const sessionStarted = performance.now();
    const { session } = await bridgeSession(request);
    marks.sessionMs = performance.now() - sessionStarted;
    const body = await readJson(request);
    const op = text(body.op, 80);
    marks.op = op;
    const input = record(body.input ?? {});
    const pool = getPool(); const actor = actorOf(session);
    switch (op) {
      case "dashboard": return Response.json(await dashboard(pool, session), { headers: { "Cache-Control": "no-store" } });
      case "requests.list": return Response.json(await listLeads(pool, actor, typeof input.status === "string" ? { status: input.status } : {}), { headers: { "Cache-Control": "no-store" } });
      case "requests.index": return Response.json(await requestsIndex(pool, session, input), { headers: { "Cache-Control": "no-store" } });
      case "requests.card": return Response.json(await requestCard(pool, session, input), { headers: { "Cache-Control": "no-store" } });
      case "calendar.view": return Response.json(await calendarView(pool, session, input), { headers: { "Cache-Control": "no-store" } });
      case "requests.search": return Response.json(await searchLeads(pool, actor, leadFilter(input)), { headers: { "Cache-Control": "no-store" } });
      case "requests.get": { const lead = await getLead(pool, actor, text(input.id, 80)); if (!lead) throw new NotFoundError(); return Response.json(lead, { headers: { "Cache-Control": "no-store" } }); }
      case "requests.status": await setLeadStatus(pool, actor, text(input.id, 80), text(input.status, 30) as "new" | "in_progress" | "cancelled", await requestMeta()); return Response.json({ ok: true });
      case "requests.workflow.update": return Response.json(await bridgeUpdateLeadWorkflow(pool, session, input, await requestMeta()), { headers: { "Cache-Control": "no-store" } });
      case "requests.workflow.claim": return Response.json(await bridgeClaimLead(pool, session, input, await requestMeta()), { headers: { "Cache-Control": "no-store" } });
      // The legacy slot-confirmation writer is deliberately unavailable in bridge mode.
      // Booking confirmation must go through payment -> interval reservation -> read-after-write.
      case "requests.confirm": throw new ConflictError("use_calendar_flow");
      case "catalog": return Response.json({ packages: await listPackages(pool), rooms: await listRooms(pool), slots: await listSlots(pool) });
      case "calendar.catalog": return Response.json(await bookingCatalog(pool), { headers: { "Cache-Control": "no-store" } });
      case "calendar.timeline": return Response.json(await bookingTimeline(pool, session, parseDate(input.date)), { headers: { "Cache-Control": "no-store" } });
      case "operations.overview": return Response.json(await operationsOverview(pool, session, input.dates), { headers: { "Cache-Control": "no-store" } });
      case "calendar.leads": { const leads = await listLeads(pool, actor, {}); return Response.json({ items: leads.map((l) => ({ id: l.id, type: "birthday_request", status: l.status, phone: l.phone, customerName: l.name, createdAt: l.createdAt.toISOString(), requestedDate: l.requestedDate, branch: { id: "almaty" } })), total: leads.length }); }
      case "calendar.lead": { const state = await calendarLeadState(pool, text(input.id, 80)); if (!state) throw new NotFoundError(); return Response.json(state); }
      case "booking.request": return Response.json(await bridgeCreateRequest(pool, session, input));
      case "booking.payment": return Response.json(await bridgePayment(pool, session, input));
      case "booking.confirm": return Response.json(await bridgeConfirm(pool, session, input));
      case "booking.block": return Response.json(await bridgeBlock(pool, session, input));
      case "booking.reschedule": return Response.json(await bridgeReschedule(pool, session, input));
      case "booking.release": return Response.json(await bridgeRelease(pool, session, input));
      case "booking.card": return Response.json(await bridgeCardGet(pool, session, input), { headers: { "Cache-Control": "no-store" } });
      case "booking.card.save": return Response.json(await bridgeCardSave(pool, session, input));
      case "booking.handover": return Response.json(await bridgeHandover(pool, session, input));
      case "attendance.view": { const date = parseDate(input.date); const saved = await searchRegistrations(pool, actor, date, { q: typeof input.q === "string" ? input.q : "", filter: input.filter as "waiting" | "confirmed" | "all", limit: Number(input.limit) || 50 }); return Response.json({ figures: await dayFigures(pool, actor, date), found: saved, entries: await listEntries(pool, actor, date), series: await attendanceSeries(pool, actor, typeof input.from === "string" ? input.from : date, typeof input.to === "string" ? input.to : date), ready: await attendanceSchemaReady(pool) }); }
      case "attendance.confirm": return Response.json(await confirmRegistrationEntry(pool, actor, { registrationId: text(input.registrationId, 80), childrenCount: Number(input.childrenCount), onDate: parseDate(input.onDate) }, await requestMeta()));
      case "attendance.manual": return Response.json(await addManualEntry(pool, actor, { childrenCount: Number(input.childrenCount), idempotencyKey: text(input.idempotencyKey, 120), onDate: parseDate(input.onDate) }, await requestMeta()));
      case "attendance.correct": return Response.json(await correctEntry(pool, actor, { entryId: text(input.entryId, 80), newCount: Number(input.newCount), expectedCount: Number(input.expectedCount), reason: text(input.reason, 80) }, await requestMeta()));
      case "contacts.list": return Response.json(await listContacts(pool, actor, input.filters as never, Number(input.page) || 1));
      case "contacts.get": return Response.json(await getContact(pool, actor, text(input.id, 80)));
      case "privacy.assess": return Response.json(await assessContact(pool, actor, text(input.id, 80)));
      case "retention.report": return Response.json(await retentionReport(pool, actor));
      case "legal.published": return Response.json(await getPublished(pool));
      case "legal.list": return Response.json(await listDocuments(pool, actor));
      case "news.list": return Response.json(await listPosts(pool, actor, { status: typeof input.status === "string" ? input.status as never : undefined }));
      case "news.get": return Response.json(await getPost(pool, actor, text(input.id, 80)));
      case "news.images": return Response.json(await listImages(pool, actor));
      case "users.list": return Response.json({ users: await listUsers(pool, actor), enrolled: [...await listEnrolledUserIds(pool, actor)] });
      case "contacts.revoke": return Response.json(await revokeConsent(pool, actor, text(input.id, 80), await requestMeta()));
      case "contacts.anonymize": return Response.json(await anonymizeContact(pool, actor, text(input.id, 80), await requestMeta()));
      case "legal.create": {
        const kind = text(input.kind, 80);
        if (!(LEGAL_KINDS as readonly string[]).includes(kind)) throw new ValidationError({ kind: "invalid" });
        return Response.json(await createDraft(pool, actor, { kind: kind as never, title: text(input.title, 200), body: text(input.body, 100000) }, await requestMeta()));
      }
      case "legal.update": return Response.json(await updateDraft(pool, actor, text(input.id, 80), { title: text(input.title, 200), body: text(input.body, 100000) }, await requestMeta()));
      case "legal.approve": return Response.json(await approveDocument(pool, actor, text(input.id, 80), await requestMeta()));
      case "legal.publish": return Response.json(await publishDocument(pool, actor, text(input.id, 80), await requestMeta()));
      case "legal.retire": return Response.json(await retireDocument(pool, actor, text(input.id, 80), await requestMeta()));
      case "news.create": return Response.json(await createPost(pool, actor, input as unknown as PostInput, await requestMeta()));
      case "news.update": return Response.json(await updatePost(pool, actor, text(input.id, 80), input as unknown as PostInput, await requestMeta()));
      case "news.publish": return Response.json(await publishPost(pool, actor, text(input.id, 80), input.publishAt ? new Date(text(input.publishAt, 40)) : null, await requestMeta()));
      case "news.unpublish": return Response.json(await unpublishPost(pool, actor, text(input.id, 80), await requestMeta()));
      case "news.delete": return Response.json(await deletePost(pool, actor, text(input.id, 80), await requestMeta()));
      case "news.deleteImage": return Response.json(await deleteImage(pool, actor, text(input.id, 80), await requestMeta()));
      case "users.create": return Response.json(await createUser(pool, actor, { email: text(input.email, 254), name: text(input.name, 120), role: text(input.role, 20) as never, password: text(input.password, 128) }, await requestMeta()));
      case "users.role": await changeRole(pool, actor, text(input.id, 80), text(input.role, 20) as never, await requestMeta()); return Response.json({ ok: true });
      case "users.active": await setActive(pool, actor, text(input.id, 80), input.active === true, await requestMeta()); return Response.json({ ok: true });
      case "users.export": await setCanExport(pool, actor, text(input.id, 80), input.allowed === true, await requestMeta()); return Response.json({ ok: true });
      case "users.password": await setPassword(pool, actor, text(input.id, 80), text(input.password, 128), await requestMeta()); return Response.json({ ok: true });
      case "users.passwordSelf": await changeOwnPassword(pool, actor, text(input.currentPassword, 128), text(input.newPassword, 128), { keepSessionId: session.sessionId, ...(await requestMeta()) }); return Response.json({ ok: true });
      case "users.resetMfa": await resetUserMfa(pool, actor, text(input.id, 80), await requestMeta()); return Response.json({ ok: true });
      case "audit.list": {
        if (!can(session.user.role, "audit.view")) throw new ForbiddenError();
        const rows = await pool.query<{ id: string; at: Date; action: string; entity_type: string | null; entity_id: string | null; actor: string | null; detail: string | null }>(
          `SELECT a.id, a.at, a.action, a.entity_type, a.entity_id, u.name AS actor,
                  left(coalesce(a.after, a.before)::text, 160) AS detail
             FROM bb.audit_log a LEFT JOIN bb.users u ON u.id = a.actor_user_id
            ORDER BY a.id DESC LIMIT 200`,
        );
        return Response.json({ rows: rows.rows.map((row) => ({ ...row, at: row.at.toISOString() })) }, { headers: { "Cache-Control": "no-store" } });
      }
      default: throw new BridgeHttpError(404, "operation_not_allowed");
    }
  } catch (error) {
    return jsonError(error);
  }
}
