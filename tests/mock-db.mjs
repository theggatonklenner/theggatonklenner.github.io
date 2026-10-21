// In-memory stand-in for the parts of Supabase the staff function uses.
export function makeDb() {
  const t = { staff_roles: [], staff_permissions: [], prep_roles: [], push_subscriptions: [] };
  const opts = { permissionsMissing: false };
  const users = []; let nextId = 1;
  const tokens = new Map();
  function query(table) {
    let rows = () => t[table], filters = [], op = 'select', payload = null, single = false;
    const q = {
      select() { return q; },
      eq(c, v) { filters.push(r => r[c] === v); return q; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
      maybeSingle() { single = true; return q; },
      limit() { return q; },
      upsert(p, opts = {}) { op = 'upsert'; payload = { rows: Array.isArray(p) ? p : [p], opts }; return q; },
      delete() { op = 'delete'; return q; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); }
    };
    function run() {
      if (table === 'staff_permissions' && opts.permissionsMissing) return { data: null, error: { message: 'relation "public.staff_permissions" does not exist' } };
      const match = r => filters.every(f => f(r));
      if (op === 'select') { const d = rows().filter(match); return { data: single ? d[0] || null : d, error: null }; }
      if (op === 'upsert') {
        for (const r of payload.rows) {
          if (table === 'staff_roles') { const i = t.staff_roles.findIndex(x => x.email === r.email); i >= 0 ? (t.staff_roles[i] = { ...r }) : t.staff_roles.push({ ...r }); }
          if (table === 'prep_roles') { if (!t.prep_roles.some(x => x.email === r.email && x.role === r.role)) t.prep_roles.push({ ...r }); }
          if (table === 'staff_permissions') { if (!t.staff_permissions.some(x => x.email === r.email && x.permission === r.permission)) t.staff_permissions.push({ ...r }); }
        }
        return { data: null, error: null };
      }
      if (op === 'delete') {
        const gone = t[table].filter(match);
        const adminCol = { prep_roles: 'role', staff_permissions: 'permission' }[table];
        if (adminCol && gone.some(r => r[adminCol] === 'admin') && !t[table].some(r => r[adminCol] === 'admin' && !gone.includes(r)))
          return { data: null, error: { message: 'There must always be at least one admin.' } };
        t[table] = t[table].filter(r => !match(r));
        return { data: null, error: null };
      }
    }
    return q;
  }
  const db = {
    from: query,
    auth: {
      async getUser(token) { const u = users.find(x => x.id === tokens.get(token)); return { data: { user: u || null } }; },
      admin: {
        async listUsers({ page, perPage }) { return { data: { users: users.slice((page - 1) * perPage, page * perPage) }, error: null }; },
        async createUser({ email, password }) {
          if (users.some(u => u.email === email)) return { error: { message: 'A user with this email address has already been registered' } };
          const u = { id: 'u' + nextId++, email, password, created_at: new Date().toISOString() }; users.push(u);
          return { data: { user: u }, error: null };
        },
        async updateUserById(id, { password }) { const u = users.find(x => x.id === id); if (!u) return { error: { message: 'User not found' } }; u.password = password; return { data: { user: u }, error: null }; },
        async deleteUser(id) { const i = users.findIndex(x => x.id === id); users.splice(i, 1); return { error: null }; }
      }
    },
    _t: t, _users: users, _opts: opts,
    _login(email) { const u = users.find(x => x.email === email); const tok = 'tok-' + u.id; tokens.set(tok, u.id); return tok; }
  };
  return db;
}

