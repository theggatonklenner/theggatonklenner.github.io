// In-memory stand-in for the parts of Supabase the staff function uses.
export function makeDb() {
  const t = { staff_roles: [], prep_roles: [], push_subscriptions: [] };
  const users = []; let nextId = 1;
  const tokens = new Map();
  function query(table) {
    let rows = () => t[table], filters = [], op = 'select', payload = null, single = false;
    const q = {
      select() { return q; },
      eq(c, v) { filters.push(r => r[c] === v); return q; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
      maybeSingle() { single = true; return q; },
      upsert(p, opts = {}) { op = 'upsert'; payload = { rows: Array.isArray(p) ? p : [p], opts }; return q; },
      delete() { op = 'delete'; return q; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); }
    };
    function run() {
      const match = r => filters.every(f => f(r));
      if (op === 'select') { const d = rows().filter(match); return { data: single ? d[0] || null : d, error: null }; }
      if (op === 'upsert') {
        for (const r of payload.rows) {
          if (table === 'staff_roles') { const i = t.staff_roles.findIndex(x => x.email === r.email); i >= 0 ? (t.staff_roles[i] = { ...r }) : t.staff_roles.push({ ...r }); }
          if (table === 'prep_roles') { if (!t.prep_roles.some(x => x.email === r.email && x.role === r.role)) t.prep_roles.push({ ...r }); }
        }
        return { data: null, error: null };
      }
      if (op === 'delete') {
        const gone = t[table].filter(match);
        if (table === 'prep_roles' && gone.some(r => r.role === 'admin') && !t.prep_roles.some(r => r.role === 'admin' && !gone.includes(r)))
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
          if (!t.staff_roles.some(r => r.email === email)) t.staff_roles.push({ email, role: 'pending' }); // card app trigger
          return { data: { user: u }, error: null };
        },
        async updateUserById(id, { password }) { const u = users.find(x => x.id === id); if (!u) return { error: { message: 'User not found' } }; u.password = password; return { data: { user: u }, error: null }; },
        async deleteUser(id) { const i = users.findIndex(x => x.id === id); users.splice(i, 1); return { error: null }; }
      }
    },
    _t: t, _users: users,
    _login(email) { const u = users.find(x => x.email === email); const tok = 'tok-' + u.id; tokens.set(tok, u.id); return tok; }
  };
  return db;
}

