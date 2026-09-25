import { api } from './api.js';
import { auditCount, auditView, loadAudit, onAuditChange, resetAudit } from './audit.js';
import { t } from './i18n.js';
import { $, closeModal, fmtDate, fmtNum, formError, h, icon, modalHeader, openModal, toast, toastError } from './ui.js';

/** Écran d'administration : comptes, rôles et permissions. */

const state = { open: false, tab: 'users', users: [], roles: [], permissions: [], groups: [], servers: [], onClose: null };

export const isAdminOpen = () => state.open;

export async function openAdmin({ servers, permissions = [], onClose }) {
  state.open = true;
  state.tab = 'users';
  state.canAudit = permissions.includes('audit.read');
  state.auditLu = false;
  resetAudit();
  // Le journal redessine l'onglet tout seul quand une page arrive.
  onAuditChange(() => state.open && state.tab === 'audit' && render());
  state.servers = servers ?? [];
  state.onClose = onClose;
  $('#domains-view').hidden = true;
  $('#files-view').hidden = true;
  $('#admin-view').hidden = false;
  $('#btn-back').hidden = false;
  for (const sel of ['#btn-conn', '#btn-refresh', '#btn-add']) $(sel).hidden = true;
  await load();
}

export function closeAdmin() {
  if (!state.open) return;
  state.open = false;
  $('#admin-view').hidden = true;
  $('#admin-view').replaceChildren();
  $('#domains-view').hidden = false;
  $('#btn-back').hidden = true;
  for (const sel of ['#btn-refresh', '#btn-add']) $(sel).hidden = false;
  state.onClose?.();
}

export const rerenderAdmin = () => state.open && render();

async function load() {
  render({ loading: true });
  try {
    const [users, roles, catalogue] = await Promise.all([api('/api/admin/users'), api('/api/admin/roles'), api('/api/admin/permissions')]);
    state.users = users.users;
    state.roles = roles.roles;
    state.permissions = catalogue.permissions;
    state.groups = catalogue.groups;
    render();
  } catch (err) {
    toastError(err);
    render({ error: err });
  }
}

// ───────────────────────── Rendu ─────────────────────────

function render({ loading = false, error = null } = {}) {
  if (!state.open) return;
  $('#page-title').textContent = t('admin.title');
  $('#page-sub').classList.remove('font-mono');
  $('#page-sub').textContent = t('admin.subtitle');
  $('#page-state').replaceChildren();

  const tab = (key, label, count) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg',
        'aria-pressed': String(state.tab === key),
        onclick: () => {
          state.tab = key;
          render();
          // Le journal se lit à la demande : on ne va pas le chercher tant que
          // personne ne l'a ouvert.
          if (key === 'audit' && !state.auditLu) {
            state.auditLu = true;
            loadAudit({ force: true });
          }
        },
      },
      // Le journal n'annonce son total qu'une fois chargé : « (0) » avant la
      // première lecture ferait croire qu'il est vide.
      count == null ? label : `${label} (${fmtNum(count)})`,
    );

  const toolbar = h(
    'div',
    { class: 'card flex flex-wrap items-center gap-3 px-4 py-3' },
    h(
      'div',
      { class: 'flex rounded-lg bg-ink-50 p-1' },
      tab('users', t('admin.tab_users'), state.users.length),
      tab('roles', t('admin.tab_roles'), state.roles.length),
      // Le journal n'apparaît que pour qui peut le lire : un onglet vide qui refuse
      // de s'ouvrir ne renseigne personne.
      state.canAudit ? tab('audit', t('admin.tab_audit'), state.auditLu ? auditCount() : null) : null,
    ),
    h('span', { class: 'flex-1' }),
    state.tab === 'users'
      ? h('button', { type: 'button', class: 'btn btn-primary px-3 py-1.5', onclick: () => userForm() }, icon('plus'), t('admin.new_user'))
      : state.tab === 'roles'
        ? h('button', { type: 'button', class: 'btn btn-primary px-3 py-1.5', onclick: () => roleForm() }, icon('plus'), t('admin.new_role'))
        : null,
  );

  const body = loading
    ? h('div', { class: 'card px-6 py-14 text-center text-ink-400' }, t('files.loading'))
    : error
      ? h('div', { class: 'card px-6 py-14 text-center text-red-600' }, error.message)
      : state.tab === 'users'
        ? usersTable()
        : state.tab === 'roles'
          ? rolesTable()
          : auditView();

  $('#admin-view').replaceChildren(toolbar, body);
}

const roleBadge = (role) => h('span', { class: 'badge bg-ink-100 text-ink-700' }, role.name);

function scopeLabel(user) {
  if (user.scopeAllServers) return t('admin.scope_all');
  if (!user.servers.length) return t('admin.scope_none');
  return user.servers.map((id) => state.servers.find((s) => s.id === id)?.label ?? id).join(', ');
}

function usersTable() {
  const head = h(
    'thead',
    { class: 'bg-ink-50/60 text-xs tracking-wide text-ink-500 uppercase' },
    h(
      'tr',
      {},
      h('th', { class: 'px-5 py-3 font-semibold' }, t('admin.col_user')),
      h('th', { class: 'px-4 py-3 font-semibold' }, t('admin.col_role')),
      h('th', { class: 'hidden px-4 py-3 font-semibold md:table-cell' }, t('admin.col_scope')),
      h('th', { class: 'px-4 py-3 font-semibold' }, t('admin.col_status')),
      h('th', { class: 'hidden px-4 py-3 font-semibold lg:table-cell' }, t('admin.col_last_login')),
      h('th', { class: 'px-5 py-3 text-right font-semibold' }, t('col.actions')),
    ),
  );

  const rows = state.users.map((user) =>
    h(
      'tr',
      { class: 'transition hover:bg-accent-50/40' },
      h(
        'td',
        { class: 'px-5 py-3' },
        h('p', { class: 'font-medium' }, user.username),
        user.displayName ? h('p', { class: 'text-xs text-ink-400' }, user.displayName) : null,
      ),
      h('td', { class: 'px-4 py-3' }, roleBadge(user.role)),
      h('td', { class: 'hidden px-4 py-3 text-ink-500 md:table-cell' }, scopeLabel(user)),
      h(
        'td',
        { class: 'px-4 py-3' },
        h('span', { class: user.isActive ? 'badge bg-accent-100 text-accent-700' : 'badge bg-ink-100 text-ink-600' }, t(user.isActive ? 'admin.active' : 'admin.inactive')),
      ),
      h('td', { class: 'hidden px-4 py-3 whitespace-nowrap text-ink-500 lg:table-cell' }, user.lastLoginAt ? fmtDate(user.lastLoginAt) : t('admin.never')),
      h(
        'td',
        { class: 'px-5 py-2' },
        h(
          'div',
          { class: 'flex justify-end gap-0.5' },
          iconBtn('pencil', t('admin.edit'), () => userForm(user)),
          iconBtn('lock', t('admin.reset_password'), () => resetPasswordForm(user)),
          iconBtn(user.isActive ? 'unlock' : 'check', t(user.isActive ? 'admin.disable' : 'admin.enable'), () => toggleActive(user)),
          iconBtn('trash', t('action.delete'), () => deleteUserForm(user), 'hover:bg-red-50 hover:text-red-600'),
        ),
      ),
    ),
  );

  return table(head, rows, t('domains.empty'));
}

function rolesTable() {
  const head = h(
    'thead',
    { class: 'bg-ink-50/60 text-xs tracking-wide text-ink-500 uppercase' },
    h(
      'tr',
      {},
      h('th', { class: 'px-5 py-3 font-semibold' }, t('admin.col_role')),
      h('th', { class: 'px-4 py-3 font-semibold' }, t('admin.col_permissions')),
      h('th', { class: 'px-4 py-3 font-semibold' }, t('admin.col_accounts')),
      h('th', { class: 'px-5 py-3 text-right font-semibold' }, t('col.actions')),
    ),
  );

  const rows = state.roles.map((role) =>
    h(
      'tr',
      { class: 'transition hover:bg-accent-50/40' },
      h(
        'td',
        { class: 'px-5 py-3' },
        h('p', { class: 'font-medium' }, role.name),
        h('p', { class: 'font-mono text-xs text-ink-400' }, role.key),
        role.isSystem ? h('span', { class: 'badge mt-1 bg-ink-100 text-ink-600' }, t('admin.system_role')) : null,
      ),
      h(
        'td',
        { class: 'px-4 py-3' },
        role.permissions.length
          ? h(
              'div',
              { class: 'flex max-w-xl flex-wrap gap-1' },
              ...role.permissions.map((p) => h('span', { class: 'badge bg-accent-50 text-accent-700' }, t(`perm.${p}`))),
            )
          : h('span', { class: 'text-ink-400' }, t('admin.no_permission')),
      ),
      h('td', { class: 'px-4 py-3 text-ink-500 tabular-nums' }, fmtNum(role.users)),
      h(
        'td',
        { class: 'px-5 py-2' },
        h(
          'div',
          { class: 'flex justify-end gap-0.5' },
          iconBtn('pencil', t('admin.edit'), () => roleForm(role), '', role.isSystem),
          iconBtn('trash', t('action.delete'), () => deleteRoleForm(role), 'hover:bg-red-50 hover:text-red-600', role.isSystem || role.users > 0),
        ),
      ),
    ),
  );

  return table(head, rows, t('domains.empty'));
}

const table = (head, rows, empty) =>
  h(
    'section',
    { class: 'card overflow-hidden' },
    h(
      'div',
      { class: 'overflow-x-auto' },
      h(
        'table',
        { class: 'w-full text-left text-sm' },
        head,
        h('tbody', { class: 'divide-y divide-ink-100' }, ...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 6, class: 'px-5 py-14 text-center text-ink-400' }, empty))])),
      ),
    ),
  );

const iconBtn = (name, label, onclick, extra = '', disabled = false) =>
  h('button', { type: 'button', class: `icon-btn ${extra}`, title: label, 'aria-label': label, onclick, disabled }, icon(name));

// ───────────────────────── Formulaires ─────────────────────────

const field = (label, control, hint) =>
  h('div', { class: 'mb-4' }, h('label', { class: 'label' }, label), control, hint ? h('p', { class: 'mt-1 text-xs text-ink-400' }, hint) : null);

const randomPassword = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 16);
};

function submitForm({ title, iconName = 'globe', tone, fields, submitLabel, run }) {
  const error = h('div', { class: 'mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const submit = h('button', { type: 'submit', class: `btn ${tone ?? 'btn-primary'}` }, submitLabel);
  const form = h(
    'form',
    {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        const previous = submit.textContent;
        submit.textContent = t('action.working');
        try {
          await run();
          closeModal();
          await load();
        } catch (err) {
          formError(err, error);
          submit.disabled = false;
          submit.textContent = previous;
        }
      },
    },
    modalHeader(title, tone === 'btn-danger' ? 'bg-red-50 text-red-600' : 'bg-accent-50 text-accent-700', iconName),
    ...fields,
    error,
    h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), submit),
  );
  openModal(form, 'max-w-lg');
}

function userForm(user = null) {
  const username = h('input', { class: 'input', value: user?.username ?? '', autocomplete: 'off', disabled: Boolean(user) });
  const displayName = h('input', { class: 'input', value: user?.displayName ?? '', autocomplete: 'off' });
  const email = h('input', { class: 'input', type: 'email', value: user?.email ?? '', autocomplete: 'off' });
  const password = h('input', { class: 'input font-mono', value: user ? '' : randomPassword(), autocomplete: 'new-password' });
  const roleSelect = h('select', { class: 'input' }, ...state.roles.map((r) => h('option', { value: r.id, selected: r.id === user?.role.id }, `${r.name} (${r.key})`)));
  const mustChange = h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', checked: !user });

  const scopeAll = h('input', { type: 'radio', name: 'scope', class: 'size-4 accent-accent', checked: user ? user.scopeAllServers : true });
  const scopeCustom = h('input', { type: 'radio', name: 'scope', class: 'size-4 accent-accent', checked: user ? !user.scopeAllServers : false });
  const serverBoxes = state.servers.map((s) =>
    h(
      'label',
      { class: 'flex items-center gap-2 text-sm' },
      h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', value: s.id, checked: user?.servers.includes(s.id) }),
      `${s.label} — ${s.host}`,
    ),
  );
  const serverList = h('div', { class: 'mt-2 ml-6 grid gap-1.5' }, ...serverBoxes);
  const syncScope = () => {
    serverList.hidden = scopeAll.checked;
  };
  scopeAll.addEventListener('change', syncScope);
  scopeCustom.addEventListener('change', syncScope);
  setTimeout(syncScope, 0);

  const chosenServers = () => serverBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);

  submitForm({
    title: user ? t('admin.edit_user_title') : t('admin.new_user'),
    iconName: 'user',
    submitLabel: user ? t('admin.edit') : t('action.create'),
    fields: [
      field(t('admin.form_username'), username),
      field(t('admin.form_display_name'), displayName),
      field(t('admin.form_email'), email),
      user ? null : field(t('admin.form_password'), password, t('admin.password_copy')),
      field(t('admin.form_role'), roleSelect),
      h(
        'div',
        { class: 'mb-4' },
        h('p', { class: 'label' }, t('admin.form_scope')),
        h('label', { class: 'flex items-center gap-2 text-sm' }, scopeAll, t('admin.form_scope_all')),
        h('label', { class: 'mt-1 flex items-center gap-2 text-sm' }, scopeCustom, t('admin.form_scope_custom')),
        serverList,
      ),
      user ? null : h('label', { class: 'mb-2 flex items-center gap-2 text-sm' }, mustChange, t('admin.form_must_change')),
    ].filter(Boolean),
    run: async () => {
      const payload = {
        displayName: displayName.value,
        email: email.value,
        roleId: Number(roleSelect.value),
        scopeAllServers: scopeAll.checked,
        servers: scopeAll.checked ? [] : chosenServers(),
      };
      if (user) {
        const updated = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: payload });
        toast(t('admin.user_updated', { username: updated.username }));
      } else {
        const created = await api('/api/admin/users', {
          method: 'POST',
          body: { ...payload, username: username.value, password: password.value, mustChangePassword: mustChange.checked },
        });
        toast(t('admin.user_created', { username: created.username }), 'success', `${t('admin.form_password')} : ${password.value}\n${t('admin.password_copy')}`);
      }
    },
  });
}

function resetPasswordForm(user) {
  const password = h('input', { class: 'input font-mono', value: randomPassword(), autocomplete: 'new-password' });
  const mustChange = h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', checked: true });
  submitForm({
    title: t('admin.reset_title'),
    iconName: 'lock',
    submitLabel: t('admin.reset_password'),
    fields: [
      h('p', { class: 'mb-4 text-sm text-ink-500' }, user.username),
      field(t('admin.form_password'), password, t('admin.reset_hint')),
      h('label', { class: 'mb-2 flex items-center gap-2 text-sm' }, mustChange, t('admin.form_must_change')),
    ],
    run: async () => {
      await api(`/api/admin/users/${user.id}/password`, { method: 'POST', body: { password: password.value, mustChangePassword: mustChange.checked } });
      toast(t('admin.password_reset', { username: user.username }), 'success', `${password.value}\n${t('admin.password_copy')}`);
    },
  });
}

async function toggleActive(user) {
  try {
    const updated = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { isActive: !user.isActive } });
    toast(t('admin.user_updated', { username: updated.username }));
    await load();
  } catch (err) {
    toastError(err);
  }
}

function deleteUserForm(user) {
  submitForm({
    title: t('admin.delete_user_title'),
    iconName: 'trash',
    tone: 'btn-danger',
    submitLabel: t('action.delete'),
    fields: [h('p', { class: 'mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800' }, t('admin.delete_user_warning', { username: user.username }))],
    run: async () => {
      await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      toast(t('admin.user_deleted', { username: user.username }));
    },
  });
}

function roleForm(role = null) {
  const name = h('input', { class: 'input', value: role?.name ?? '', autocomplete: 'off' });
  const key = h('input', { class: 'input font-mono', value: role?.key ?? '', autocomplete: 'off', disabled: Boolean(role) });
  const boxes = new Map();

  const groups = state.groups.map((group) => {
    const perms = state.permissions.filter((p) => p.group === group);
    return h(
      'div',
      { class: 'mb-3 rounded-xl border border-ink-100 p-3' },
      h('p', { class: 'mb-2 text-xs font-semibold tracking-wide text-ink-500 uppercase' }, t(`perm_group.${group}`)),
      ...perms.map((p) => {
        const box = h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', checked: role?.permissions.includes(p.key) });
        boxes.set(p.key, box);
        return h('label', { class: 'flex items-center gap-2 py-0.5 text-sm' }, box, t(`perm.${p.key}`));
      }),
    );
  });

  submitForm({
    title: role ? t('admin.edit_role_title') : t('admin.new_role'),
    iconName: 'shield',
    submitLabel: role ? t('admin.edit') : t('action.create'),
    fields: [
      field(t('admin.role_name'), name),
      field(t('admin.role_key'), key),
      h('p', { class: 'label' }, t('admin.role_permissions')),
      ...groups,
    ],
    run: async () => {
      const permissions = [...boxes].filter(([, box]) => box.checked).map(([perm]) => perm);
      if (role) {
        const updated = await api(`/api/admin/roles/${role.id}`, { method: 'PATCH', body: { name: name.value, permissions } });
        toast(t('admin.role_updated', { name: updated.name }));
      } else {
        const created = await api('/api/admin/roles', { method: 'POST', body: { key: key.value, name: name.value, permissions } });
        toast(t('admin.role_created', { name: created.name }));
      }
    },
  });
}

function deleteRoleForm(role) {
  submitForm({
    title: t('admin.delete_role_title'),
    iconName: 'trash',
    tone: 'btn-danger',
    submitLabel: t('action.delete'),
    fields: [h('p', { class: 'mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800' }, t('admin.delete_role_warning', { name: role.name }))],
    run: async () => {
      await api(`/api/admin/roles/${role.id}`, { method: 'DELETE' });
      toast(t('admin.role_deleted', { name: role.name }));
    },
  });
}

// ───────────────────────── Mon compte (tous les rôles) ─────────────────────────

export function accountDialog(user, { forced = false } = {}) {
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const error = h('div', { class: 'mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, t('account.change_password'));

  const info = (label, value) =>
    h('div', { class: 'flex justify-between border-b border-ink-100 py-2 text-sm' }, h('span', { class: 'text-ink-500' }, label), h('span', { class: 'font-medium' }, value));

  const form = h(
    'form',
    {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        if (next.value !== confirm.value) return formError({ message: t('account.mismatch') }, error);
        submit.disabled = true;
        try {
          await api('/api/auth/password', { method: 'POST', body: { current: current.value, password: next.value } });
          closeModal();
          toast(t('account.changed'));
          if (forced) window.location.reload();
        } catch (err) {
          formError(err, error);
          submit.disabled = false;
        }
      },
    },
    modalHeader(t('account.title'), 'bg-accent-50 text-accent-700', 'user'),
    info(t('admin.form_username'), user.username),
    info(t('account.role'), user.role.name),
    info(t('account.scope'), user.scopeAllServers ? t('admin.scope_all') : user.servers.join(', ') || t('admin.scope_none')),
    forced ? h('p', { class: 'mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800' }, t('account.must_change')) : null,
    h('div', { class: 'mt-5' }, field(t('account.current'), current), field(t('account.new'), next), field(t('account.confirm'), confirm)),
    error,
    h(
      'div',
      { class: 'mt-2 flex justify-end gap-2' },
      forced ? null : h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.close')),
      submit,
    ),
  );
  openModal(form, 'max-w-md');
}
