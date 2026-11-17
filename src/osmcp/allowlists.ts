// Per-app Orion MCP tool allowlists — exact tool names only (no "_*" prefixes). Used both by
// OsMcpClient's client-side `allow` predicate and by each app's CLI wiring for
// `--allowedTools mcp__orion__<name>` (prefix wildcards are unreliable there, per the plan's
// gotcha #3 — so this is the single source of truth for both).
//
// IMPORTANT (verified live against the real project, 2026-07-27): this allowlist is the PRIMARY
// department-scoping boundary for reads, not defense-in-depth on top of RLS. Audited SELECT
// policies across every table these tools touch — only payments/invoices/forms/form_submissions/
// reviews/review_requests/workflows check a real permission (`user_has_..._permission(...)`); every
// other table (projects, contacts, opportunities, conversations, calendars, social_*, drive_*,
// ai_agents, integrations, messages, snippets, reports, proposals, contracts, clara_memories, ...)
// only checks org membership — ANY authenticated org user can read ALL rows regardless of role.
// Confirmed directly: a freshly-minted agent JWT successfully listed `projects_list` data
// straight against the MCP server, even though that agent was never granted projects.* — RLS let
// it through. This allowlist is what actually stops that call from ever leaving the agent's app in
// normal operation; if it were ever bypassed (leaked JWT, buggy tool-name change), most tables have
// no second line of defense. Don't weaken this list on the assumption RLS has your back — for most
// tables it doesn't yet. Hardening Orion's own RLS to check role_permissions per table is real,
// separate, CRM-side work, out of scope for this integration.
//
// Shared here (not duplicated per-app) so FRIDAY/CLARA can't silently drift out of sync
// with each other or with the real tool names registered in mcp-server/src/tools/*.ts.
//
// Projects (M3, 2026-09-12): FRIDAY carries the projects_* / project_pipelines_* /
// project_activity_* tools — an agent mirrors its own work into the ONE pipeline it owns
// (project_pipelines.owner_agent, e.g. Engineering → friday). Per-pipeline scoping
// is enforced SERVER-SIDE in those MCP tools (projects_create forces the caller's pipeline and
// refuses a foreign one; projects_update refuses projects outside it and stage ids outside the
// project's pipeline), so this allowlist is no longer the only thing keeping an agent out of
// another department's projects. It remains the MODULE boundary — which tool families an agent may reach
// at all — and project_move_stage stays FRIDAY-only by design: the sync engine writes stages via
// projects_update (which records the portal-visible stage_changed activity), never move_stage.
//
// Deliberately excluded everywhere: auth.ts (account/session management — auth_create_user is on
// the "I don't create accounts" list), administration.ts (org/role/user administration), and any
// credential/OAuth-connect tool (drive_oauth_*, gmail_oauth_start, google_oauth_unified,
// google_token_refresh, google_calendar_oauth, secrets_api, secrets_scanner, portal_auth,
// late_connect) — connecting new integrations is a human, interactive action. Destructive/
// approval-gated actions (hard deletes, workflow_approval_queue_update, automations.approve,
// payment issuance/void) are excluded per-app below even where the module is otherwise in scope.

/** FRIDAY — Engineering: projects, project tasks, opportunities (incl. conversion to project),
 *  contacts (no merge/bulk/delete), files, workflows/automation, AI agent config, integrations
 *  (no connect/credential tools), forms, reporting (read-only). */
export const FRIDAY_OS_TOOLS: readonly string[] = [
  // 2026-10-29: FRIDAY pushes her own model-call ledger to the OS (Agent Health costs) and may read
  // her effective per-agent settings over MCP. Both act only on the calling agent's own rows.
  "agent_usage_report", "agent_settings_get",
  // projects
  "projects_list", "projects_get", "projects_create", "projects_update",
  "project_agent_meta_get", "project_agent_meta_set",
  "project_tasks_list", "project_tasks_create", "project_tasks_update", "project_tasks_delete",
  "project_change_requests_list", "project_change_requests_create", "project_change_requests_update",
  // The former support_tickets_* trio pointed at a table that never existed; the real
  // client-portal surface is project_support_tickets / project_support_ticket_comments.
  "project_support_tickets_list", "project_support_tickets_get", "project_support_tickets_update",
  // 2026-10-05: mirror client issues that arrive by email/SMS/meeting into the portal.
  "project_support_tickets_create",
  "project_support_ticket_comments_list", "project_ticket_comment_create",
  "project_change_request_comments_list", "project_change_request_comments_create",
  "contract_scope_index_get", "project_contacts_list", "project_contacts_add",
  "support_ticket_notify", "change_request_notify",
  "project_pipelines_list", "project_pipelines_get", "project_stages_list", "project_move_stage", "convert_opportunity_to_project",
  "project_costs_list", "project_costs_create", "project_costs_update",
  "project_notes_create", "project_notes_update",
  "project_activity_list",
  // Client-visible narrative updates for the portal "Project Updates" feed
  // (posted by the daily portal-updates job on merged PRs / landed commits).
  "project_activity_create",
  // Per-build client sign-offs (the "Ready for your review" portal card +
  // the office merge panel) — filed by the release-approvals job.
  "project_release_approval_create", "project_release_approval_list", "project_release_approval_update",
  // opportunities
  "opportunities_list", "opportunities_get", "opportunities_create", "opportunities_update",
  "opportunities_bulk_update_stage", "opportunity_notes_list", "opportunity_notes_create",
  "opportunity_close", "opportunity_reopen", "opportunity_stage_history_list",
  "opportunity_timeline_list", "opportunity_timeline_create", "opportunity_set_custom_fields", "opportunity_stats",
  // contacts
  "contacts_list", "contacts_get", "contacts_create", "contacts_update",
  "contact_agent_meta_get", "contact_agent_meta_set",
  "contact_notes_list", "contact_notes_create", "contact_notes_update",
  "contact_tasks_list", "contact_tasks_create", "contact_tasks_update", "contact_tasks_delete",
  "tags_list", "tags_create", "contact_tags_add", "contact_tags_remove",
  "custom_fields_list", "custom_field_values_set",
  "contact_timeline_list", "contact_timeline_add",
  "contact_voice_verify",
  // files
  "drive_files_list", "drive_files_get", "drive_files_create", "drive_files_update", "drive_files_delete",
  "drive_folders_list", "drive_folders_create", "drive_folders_update", "drive_folders_delete",
  "file_attachments_list", "file_attachments_create", "file_attachments_delete",
  // workflows / automation
  "workflows_list", "workflows_get", "workflows_create", "workflows_update", "workflows_delete",
  "workflow_enrollments_list", "workflow_enrollments_create", "workflow_enrollments_update",
  "workflow_approval_queue_list",
  "workflow_processor", "evaluate_condition", "workflow_ai_action_executor", "workflow_scheduled_processor",
  "workflow_ai_generate", "workflow_publish", "workflow_duplicate", "workflow_versions_list",
  "workflow_scheduled_triggers_list", "workflow_scheduled_triggers_create", "workflow_scheduled_triggers_update", "workflow_scheduled_triggers_delete",
  "workflow_analytics_get",
  // ai_agents (FRIDAY's own domain — excludes ElevenLabs voice config, that's CLARA/voice-ai's)
  "ai_agents_list", "ai_agents_get", "ai_agents_create", "ai_agents_update", "ai_agents_delete",
  "knowledge_collections_list", "knowledge_collections_create", "knowledge_collections_update", "knowledge_collections_delete",
  "ai_agent_execute", "ai_knowledge_embed", "ai_settings_providers", "fetch_provider_models",
  // integrations (no connect/credential tools)
  "integrations_list", "integrations_get",
  "integration_connections_list", "integration_connections_create", "integration_connections_update", "integration_connections_delete",
  "outgoing_webhooks_list", "outgoing_webhooks_create", "outgoing_webhooks_update", "outgoing_webhooks_delete",
  "webhook_deliveries_list", "integrations_webhooks",
  // forms
  "forms_list", "forms_get", "forms_create", "forms_update", "forms_delete",
  "form_submissions_list", "form_submissions_get",
  // reporting (read-only)
  "reports_list", "analytics_dashboard", "report_export",
  // agent tasks (OS-scheduled work): poll/report + owner-facing delivery + orchestration reads
  "agent_whoami", "agent_tasks_poll", "agent_run_report", "agent_run_deliver_confirm", "agent_run_extend_lease",
  "agent_task_runs_list", "agent_task_schedules_list", "deliverable_publish",
  "team_message_send", "team_channels_list",
  // approvals bridge (Wave 3): mirror pending approvals to the hub, pull owner decisions back
  "agent_approval_mirror", "agent_approval_pull_decisions", "agent_approval_ack", "agent_approval_close",
  // one-off requests from other agents (Clara hands FRIDAY free-form work): claim, keep alive, settle,
  // and ask a booked client a question by phone for a request FRIDAY is holding
  "agent_requests_poll", "agent_request_report", "agent_request_extend_lease", "agent_requests_list", "agent_request_ask_by_phone",
  // reach the owner through Clara (replaces FRIDAY emailing the owner / asking the CLARA app to ring them)
  "agent_notify_owner",
  // draft a client email into the owner's approval queue (Clara sends it after the owner approves)
  "agent_draft_client_email",
  // 2026-10-28 FRIDAY audit fix contract (agreed with the OS side). Owned by the OS
  // batch; FRIDAY calls them tolerantly (a missing tool is logged and degrades, never crashes).
  //   §1 code runs → OS
  "agent_code_runs_report", "agent_code_runs_list",
  //   §2 client review through the project portal (replaces the Gmail review loop)
  "client_reviews_create", "client_reviews_list", "client_reviews_update",
  //   §4 non-portal client sends logged into Conversations
  "conversation_log_message",
  //   §6 org-level client-comms switch
  "org_settings_get",
  // 2026-10-29 project knowledge (read path; agreed with the OS side).
  // Read tools + the write tools the updater and the cold-start explorer use (upsert/mark_stale/sync_state).
  "project_knowledge_index", "project_knowledge_get",
  "project_knowledge_upsert", "project_knowledge_mark_stale", "project_knowledge_sync_state",
] as const;

// Email/SMS compliance (Orion mcp-server/src/tools/compliance.ts). The Prospect Intelligence
// Engine these once lived beside was retired from the OS 2026-10-28;
// only the compliance tools survive, and CLARA owns them. Deliberately NOT here:
// `suppressions_remove` (draft-then-approve, owner only).
export const COMPLIANCE_OS_TOOLS: readonly string[] = [
  "suppressions_check", "suppressions_add", "suppressions_list", "consents_add", "consents_list",
  // unsubscribe-link slugs
  "tracked_links_create",
] as const;

// The Office's own read-only OS identity: compliance reads only — never a write. Writes from the
// Office go to CLARA over the interagent boundary so they pass her tier table. `pipelines_list` is
// here for the "Add to pipeline" picker.
export const OFFICE_OS_TOOLS: readonly string[] = [
  "suppressions_check", "suppressions_list", "consents_list",
  "pipelines_list",
] as const;

/** CLARA — authenticates AS the owner, so scope is broad by identity rather than department. Full
 *  access to calendars, contacts, communications (incl. phone_* — she owns the business-line
 *  cutover), conversations, proposals/contracts, reporting, files, and the full personal-assistant
 *  / Clara-memory tool family (Vapi Voice-AI retired 2026-10-28; Clara replaces it). Read-only on projects and payments. Administration and
 *  auth tools stay excluded even under the owner's identity — that boundary is app-level, not RLS. */
export const CLARA_OS_TOOLS: readonly string[] = [
  // calendars (full — the owner's own calendar)
  "calendars_list", "calendars_get", "calendars_create", "calendars_update", "calendars_delete",
  "appointments_list", "appointments_get", "appointments_create", "appointments_update", "appointments_delete",
  "availability_rules_list", "availability_rules_create", "availability_rules_update", "availability_rules_delete",
  "booking_api", "google_calendar_sync",
  "appointment_types_list", "appointment_types_get", "appointment_types_create", "appointment_types_update", "appointment_types_delete",
  "blocked_slots_list", "blocked_slots_create", "blocked_slots_update", "blocked_slots_delete",
  "google_calendar_connections_list",
  // contacts (full)
  "contacts_list", "contacts_get", "contacts_create", "contacts_update", "contacts_delete",
  "contacts_bulk_assign_owner",
  "contact_notes_list", "contact_notes_create", "contact_notes_update", "contact_notes_delete",
  "contact_tasks_list", "contact_tasks_create", "contact_tasks_update", "contact_tasks_delete",
  "tags_list", "tags_create", "contact_tags_add", "contact_tags_remove",
  "custom_fields_list", "custom_field_values_set", "contacts_merge",
  "contact_timeline_list", "contact_timeline_add",
  "contact_voice_verify",
  // communications (incl. phone_* — Clara owns the live number after the B4 cutover)
  "call_logs_list", "email_domains_list", "email_from_addresses_list",
  "email_send", "send_sms",
  "phone_settings", "phone_voice_routing", "phone_dnc", "phone_test",
  // conversations (full)
  "conversations_list", "conversations_get", "conversations_create", "conversations_update", "conversations_delete",
  "messages_list", "messages_create",
  "snippets_list", "snippets_create", "snippets_update", "snippets_delete",
  "conversation_rule_execute", "ai_draft_generate",
  // proposals / contracts (full — the owner's own deals)
  "proposals_list", "proposals_get", "proposals_create", "proposals_update", "proposals_delete",
  "contracts_list", "contracts_get", "contracts_create", "contracts_update", "contracts_delete",
  "proposal_ai_generate", "contract_ai_generate", "proposal_signed_pdf",
  "proposal_line_items_list", "proposal_line_items_create", "proposal_line_items_update", "proposal_line_items_delete",
  "proposal_sections_list", "proposal_sections_create", "proposal_sections_update", "proposal_sections_delete",
  "proposal_duplicate", "proposal_archive", "proposal_unarchive",
  "proposal_link_meeting", "proposal_unlink_meeting",
  "proposal_templates_list", "proposal_templates_get", "proposal_templates_create", "proposal_templates_update", "proposal_templates_delete",
  "proposal_signature_status_get", "proposal_comments_list", "proposal_comments_create",
  "contract_sections_list", "contract_sections_create", "contract_sections_update", "contract_sections_delete",
  "contract_link_meeting", "contract_unlink_meeting", "contract_archive", "contract_unarchive",
  "contract_signature_status_get", "contract_comments_list", "contract_comments_create",
  "proposal_send_for_signature", "proposal_signature_resend", "proposal_signature_void",
  "contract_send_for_signature", "contract_signature_resend", "contract_signature_void",
  // reporting (full)
  "reports_list", "reports_create", "reports_update", "reports_delete",
  "ai_reports_list", "ai_reports_get", "ai_reports_create", "ai_reports_delete",
  "ai_report_generate", "ai_report_query", "ai_report_cleanup", "ai_report_schedule_run",
  "analytics_dashboard", "report_export", "report_email_send",
  // files (full)
  "drive_files_list", "drive_files_get", "drive_files_create", "drive_files_update", "drive_files_delete",
  "drive_folders_list", "drive_folders_create", "drive_folders_update", "drive_folders_delete",
  "file_attachments_list", "file_attachments_create", "file_attachments_delete",
  // projects — read, plus the client-portal ticket surface CLARA triages for projects NO bench owns
  // (2026-09-14). Ticket writes are comment + status only; projects_update stays excluded.
  "projects_list", "projects_get", "project_tasks_list", "project_activity_list",
  "project_pipelines_list", "project_agent_meta_get", "project_contacts_list",
  "project_support_tickets_list", "project_support_tickets_get", "project_support_tickets_update",
  "project_support_ticket_comments_list", "project_ticket_comment_create",
  // opportunities — reads since 2026-08-03 ("what's in my pipeline" is an executive-assistant
  // question), plus the Phase 5 deal tranche (CLARA deals.ts, previously a local
  // DEAL_TOOL_EXTENSION folded in here 2026-09-30): pipelines_list for id resolution, and
  // opportunities_create / opportunities_update, which are reachable ONLY through the create_deal
  // and move_deal_stage intent tools — both reversible:false, so every call rides the approval
  // rail to the owner. Still no opportunities_delete anywhere (hard deletes stay off her surface).
  "opportunities_list", "opportunities_get", "opportunity_stats",
  "opportunity_stage_history_list", "opportunity_notes_list",
  "pipelines_list", "opportunities_create", "opportunities_update",
  // payments — read-only
  "invoices_list", "invoices_get", "payments_list", "products_list",
  "invoice_line_items_list", "recurring_profiles_list", "invoice_templates_list", "payment_reminders_list",
  // personal assistant / Clara memory / meetings / notifications / prefs
  "assistant_threads_list", "assistant_threads_get", "assistant_threads_create", "assistant_threads_delete",
  "clara_memories_list", "meeting_transcriptions_list",
  "assistant_chat", "assistant_voice", "assistant_tts", "assistant_stt_wake", "assistant_stt_final",
  "clara_memory_decay", "assistant_meeting_processor",
  "google_calendar_sync_runner", "meet_reprocess", "meet_follow_up_generate", "dashboard_insights",
  "notifications_list", "notifications_create", "notifications_mark_read", "notifications_mark_all_read", "notifications_delete",
  "user_preferences_get", "user_preferences_update", "user_notification_preferences_get", "user_connected_accounts_list",
  "custom_values_list", "custom_values_create", "custom_values_update", "custom_values_delete", "custom_value_categories_list",
  // agent tasks (OS-scheduled work): poll/report + owner-facing delivery
  "agent_whoami", "agent_tasks_poll", "agent_run_report", "agent_run_deliver_confirm", "agent_run_extend_lease",
  "agent_task_runs_list", "team_message_send", "team_channels_list",
  // approvals bridge (Wave 3): mirror pending approvals to the hub, pull owner decisions back
  "agent_approval_mirror", "agent_approval_pull_decisions", "agent_approval_ack", "agent_approval_close",
  // readiness-scorecard SMS follow-up (Clara owns the texts; both RPCs are org-scoped, consent-gated)
  "scorecard_drip_candidates", "scorecard_drip_event", "scorecard_lead_lookup",
  // email/SMS compliance (see COMPLIANCE_OS_TOOLS above)
  ...COMPLIANCE_OS_TOOLS,
] as const;

/** Exact-match allow predicate for OsMcpConfig.allow — no prefix matching, mirrors --allowedTools. */
export function allowExact(tools: readonly string[]): (toolName: string) => boolean {
  const set = new Set(tools);
  return (toolName) => set.has(toolName);
}

/** Full `mcp__orion__<tool>` names for a Claude Code CLI `--allowedTools` list. */
export function toCliAllowedTools(tools: readonly string[]): string[] {
  return tools.map((t) => `mcp__orion__${t}`);
}
