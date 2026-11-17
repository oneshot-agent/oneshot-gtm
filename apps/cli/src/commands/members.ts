import { getSharedDb, normalizeAllowedHost, normalizeMemberEmail } from "@oneshot-gtm/core";
import { bail, c, header, note, ok, warn } from "../output.ts";

/**
 * `members`: who may use this install from another machine, and on which
 * hostnames the dashboards answer besides loopback. Both lists live in the
 * shared database, so every workspace's server agrees. Run on the host; the
 * dashboards read the lists on each request, so nothing needs a restart.
 */

function emailOrBail(input: string): string {
  return normalizeMemberEmail(input) ?? bail(`not an email address: ${input}`);
}

function hostOrBail(input: string): string {
  return (
    normalizeAllowedHost(input) ??
    bail(
      `not a hostname to allow: ${input} (give the name people browse to, like host.tailnet.ts.net; loopback is always allowed on this machine)`,
    )
  );
}

export async function commandMembersAdd(
  emailInput: string,
  opts: { owner?: boolean; name?: string } = {},
): Promise<void> {
  const email = emailOrBail(emailInput);
  const db = getSharedDb();
  const { member, outcome } = db.addMember({
    email,
    name: opts.name ?? null,
    role: opts.owner ? "owner" : "member",
  });
  const who = member.name ? `${member.name} <${member.email}>` : member.email;
  const verb = outcome === "added" ? "added" : outcome === "restored" ? "added back" : "updated";
  ok(`${verb} ${c.cyan(who)} as ${member.role}`);
  if (db.allowedHosts().length === 0) {
    note("No host is allowed yet, so members cannot reach the dashboards. Allow one with:");
    note(`  ${c.cyan("bun run cli -- members allow-host <host>")}`);
  }
}

export async function commandMembersRemove(emailInput: string): Promise<void> {
  const email = emailOrBail(emailInput);
  if (!getSharedDb().removeMember(email)) bail(`no active member with email ${email}`);
  ok(`removed ${c.cyan(email)}; their next request is refused`);
}

export async function commandMembersList(): Promise<void> {
  header("oneshot-gtm members");
  const db = getSharedDb();
  const members = db.listMembers();
  if (members.length === 0) {
    note("  No members. Only this machine can open the dashboards.");
  }
  for (const m of members) {
    note(`  ${m.email.padEnd(32)} ${m.role.padEnd(7)} ${m.name ?? ""}`.trimEnd());
  }
  const hosts = db.allowedHosts();
  note("");
  note(
    hosts.length
      ? `Allowed hosts: ${hosts.join(", ")}`
      : "Allowed hosts: none (loopback on this machine only)",
  );
}

export async function commandMembersAllowHost(hostInput: string): Promise<void> {
  const host = hostOrBail(hostInput);
  const db = getSharedDb();
  if (db.allowHost(host)) ok(`allowed ${c.cyan(host)} on every workspace's dashboard`);
  else ok(`${c.cyan(host)} was already allowed`);
  if (db.listMembers().length === 0) {
    warn("No members yet, so every request on that host is refused. Add one: members add <email>");
  }
}

export async function commandMembersDisallowHost(hostInput: string): Promise<void> {
  const host = hostOrBail(hostInput);
  if (!getSharedDb().disallowHost(host)) bail(`${host} is not on the allowed list`);
  ok(`${c.cyan(host)} is no longer allowed; requests on it are refused`);
}
