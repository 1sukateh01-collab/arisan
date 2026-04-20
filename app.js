// ======= SUPABASE CONFIG =======
const SUPABASE_URL = 'https://nvfzcjbbblxijafrtzuz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_d7s3cWfzb_CmEwg_8iBCBw_E2-Xq2M1';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ======= ADMIN MODE =======
// Password default pertama kali = 'admin123'. Ganti di tab Pengaturan.
const DEFAULT_ADMIN_PWD = 'admin123';
const ADMIN_KEY = 'arisan-admin-v1';
let isAdmin = localStorage.getItem(ADMIN_KEY) === 'yes';
let adminHash = null; // loaded from Supabase

async function hashPassword(pwd) {
    const buf = new TextEncoder().encode(pwd);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function getExpectedHash() {
    return adminHash || await hashPassword(DEFAULT_ADMIN_PWD);
}

function applyAdminUI() {
    document.body.classList.toggle('is-admin', isAdmin);
    const btn = document.getElementById('adminBtn');
    if (btn) btn.textContent = isAdmin ? '🔓 Logout' : '🔒 Admin';
}

// ======= STATE (in-memory cache) =======
function defaultDB() {
    return {
        settings: {
            namaArisan: 'Arisan Saya',
            nominal: 100000,
            periode: 'bulanan',
            tanggalMulai: new Date().toISOString().slice(0, 10)
        },
        peserta: [],
        setoran: {},
        riwayat: [],
        periodeAktif: 1
    };
}

let db = defaultDB();
let periodeView = 1;
let editingPesertaId = null;
let kocokTimer = null;
let currentWinnerId = null;

// ======= HELPERS =======
function fmtRp(n) {
    return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
}

function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function getWinnerSet() {
    return new Set(db.riwayat.map(r => r.pesertaId));
}

function toast(msg, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2400);
}

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function setLoading(on, msg) {
    const ov = document.getElementById('loadingOverlay');
    if (msg) ov.querySelector('p').textContent = msg;
    ov.classList.toggle('hidden', !on);
}

async function handleError(fn, errMsg) {
    try { return await fn(); }
    catch (err) {
        console.error(err);
        toast((errMsg || 'Error') + ': ' + (err.message || err), true);
        throw err;
    }
}

// ======= SUPABASE DATA LAYER =======
async function loadAll() {
    const [settingsRes, pesertaRes, setoranRes, riwayatRes] = await Promise.all([
        sb.from('settings').select('*').eq('id', 1).maybeSingle(),
        sb.from('peserta').select('*').order('created_at', { ascending: true }),
        sb.from('setoran').select('*'),
        sb.from('riwayat').select('*').order('periode', { ascending: true })
    ]);

    if (settingsRes.error) throw settingsRes.error;
    if (pesertaRes.error) throw pesertaRes.error;
    if (setoranRes.error) throw setoranRes.error;
    if (riwayatRes.error) throw riwayatRes.error;

    if (settingsRes.data) {
        db.settings.namaArisan = settingsRes.data.nama_arisan;
        db.settings.nominal = settingsRes.data.nominal;
        db.settings.periode = settingsRes.data.periode;
        db.settings.tanggalMulai = settingsRes.data.tanggal_mulai;
        db.periodeAktif = settingsRes.data.periode_aktif;
        adminHash = settingsRes.data.admin_hash || null;
    }

    db.peserta = (pesertaRes.data || []).map(p => ({
        id: p.id, nama: p.nama, hp: p.hp || '', catatan: p.catatan || ''
    }));

    db.setoran = {};
    (setoranRes.data || []).forEach(row => {
        if (!db.setoran[row.periode]) db.setoran[row.periode] = {};
        db.setoran[row.periode][row.peserta_id] = true;
    });

    db.riwayat = (riwayatRes.data || []).map(r => ({
        periode: r.periode,
        pesertaId: r.peserta_id,
        nama: r.nama,
        tanggal: r.tanggal,
        jumlah: r.jumlah
    }));
}

async function dbAddPeserta(data) {
    const { data: inserted, error } = await sb.from('peserta').insert({
        nama: data.nama, hp: data.hp || null, catatan: data.catatan || null
    }).select().single();
    if (error) throw error;
    db.peserta.push({
        id: inserted.id, nama: inserted.nama,
        hp: inserted.hp || '', catatan: inserted.catatan || ''
    });
}

async function dbUpdatePeserta(id, data) {
    const { error } = await sb.from('peserta').update({
        nama: data.nama, hp: data.hp || null, catatan: data.catatan || null
    }).eq('id', id);
    if (error) throw error;
    const p = db.peserta.find(x => x.id === id);
    if (p) { p.nama = data.nama; p.hp = data.hp; p.catatan = data.catatan; }
}

async function dbDeletePeserta(id) {
    const { error } = await sb.from('peserta').delete().eq('id', id);
    if (error) throw error;
    db.peserta = db.peserta.filter(p => p.id !== id);
    db.riwayat = db.riwayat.filter(r => r.pesertaId !== id);
    Object.keys(db.setoran).forEach(k => { delete db.setoran[k][id]; });
}

async function dbSetSetoran(periode, pesertaId, lunas) {
    if (lunas) {
        const { error } = await sb.from('setoran')
            .upsert({ periode, peserta_id: pesertaId }, { onConflict: 'periode,peserta_id', ignoreDuplicates: true });
        if (error) throw error;
        if (!db.setoran[periode]) db.setoran[periode] = {};
        db.setoran[periode][pesertaId] = true;
    } else {
        const { error } = await sb.from('setoran').delete()
            .eq('periode', periode).eq('peserta_id', pesertaId);
        if (error) throw error;
        if (db.setoran[periode]) delete db.setoran[periode][pesertaId];
    }
}

async function dbUpdateSettings(patch) {
    const dbPatch = {};
    if ('namaArisan' in patch) dbPatch.nama_arisan = patch.namaArisan;
    if ('nominal' in patch) dbPatch.nominal = Number(patch.nominal) || 0;
    if ('periode' in patch) dbPatch.periode = patch.periode;
    if ('tanggalMulai' in patch) dbPatch.tanggal_mulai = patch.tanggalMulai || null;
    if ('periodeAktif' in patch) dbPatch.periode_aktif = Number(patch.periodeAktif);
    const { error } = await sb.from('settings').update(dbPatch).eq('id', 1);
    if (error) throw error;
    if ('namaArisan' in patch) db.settings.namaArisan = patch.namaArisan;
    if ('nominal' in patch) db.settings.nominal = Number(patch.nominal) || 0;
    if ('periode' in patch) db.settings.periode = patch.periode;
    if ('tanggalMulai' in patch) db.settings.tanggalMulai = patch.tanggalMulai;
    if ('periodeAktif' in patch) db.periodeAktif = Number(patch.periodeAktif);
}

async function dbSaveWinner(periode, peserta, jumlah) {
    const tanggal = new Date().toISOString();
    const { error } = await sb.from('riwayat').upsert({
        periode, peserta_id: peserta.id, nama: peserta.nama, tanggal, jumlah
    }, { onConflict: 'periode' });
    if (error) throw error;
    db.riwayat = db.riwayat.filter(r => r.periode !== periode);
    db.riwayat.push({ periode, pesertaId: peserta.id, nama: peserta.nama, tanggal, jumlah });
}

async function dbDeleteRiwayat(periode) {
    const { error } = await sb.from('riwayat').delete().eq('periode', periode);
    if (error) throw error;
    db.riwayat = db.riwayat.filter(r => r.periode !== periode);
}

async function dbResetAll() {
    const zeroUUID = '00000000-0000-0000-0000-000000000000';
    const { error: e1 } = await sb.from('peserta').delete().neq('id', zeroUUID);
    if (e1) throw e1;
    const { error: e2 } = await sb.from('settings').update({
        nama_arisan: 'Arisan Saya',
        nominal: 100000,
        periode: 'bulanan',
        tanggal_mulai: new Date().toISOString().slice(0, 10),
        periode_aktif: 1
    }).eq('id', 1);
    if (e2) throw e2;
    db = defaultDB();
    periodeView = 1;
}

// ======= REALTIME SYNC =======
function subscribeRealtime() {
    sb.channel('arisan-sync')
        .on('postgres_changes', { event: '*', schema: 'public' }, async () => {
            await loadAll();
            const activeTab = document.querySelector('.tab.active')?.dataset.tab || 'dashboard';
            switchTab(activeTab);
        })
        .subscribe();
}

// ======= TABS =======
function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.panel-tab').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    if (name === 'dashboard') renderDashboard();
    else if (name === 'peserta') renderPeserta();
    else if (name === 'setoran') renderSetoran();
    else if (name === 'kocok') renderKocok();
    else if (name === 'riwayat') renderRiwayat();
    else if (name === 'pengaturan') renderPengaturan();
}

document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
});

// ======= DASHBOARD =======
function renderDashboard() {
    const total = db.peserta.length;
    const winnerSet = getWinnerSet();
    const menangCount = winnerSet.size;

    document.getElementById('statPeserta').textContent = total;
    document.getElementById('statPeriode').textContent = db.periodeAktif;
    document.getElementById('statMenang').textContent = `${menangCount} / ${total}`;

    let totalUang = 0;
    Object.values(db.setoran).forEach(p => {
        Object.values(p).forEach(v => { if (v) totalUang += db.settings.nominal; });
    });
    document.getElementById('statUang').textContent = fmtRp(totalUang);

    const sPer = db.setoran[db.periodeAktif] || {};
    const bayar = db.peserta.filter(p => sPer[p.id]).length;
    const pct = total > 0 ? Math.round((bayar / total) * 100) : 0;
    document.getElementById('dashSetoranPct').textContent = pct + '%';
    document.getElementById('dashSetoranText').textContent = `${bayar} / ${total} bayar`;

    const belum = db.peserta.filter(p => !winnerSet.has(p.id));
    const ulBelum = document.getElementById('dashBelumMenang');
    if (belum.length === 0) {
        ulBelum.innerHTML = '<li class="empty">Semua sudah menang 🎉</li>';
    } else {
        ulBelum.innerHTML = belum.map(p => `<li>${escapeHtml(p.nama)}</li>`).join('');
    }

    const dashPemenang = document.getElementById('dashPemenang');
    if (db.riwayat.length === 0) {
        dashPemenang.className = 'winner-box empty';
        dashPemenang.innerHTML = 'Belum ada pemenang';
    } else {
        const sorted = [...db.riwayat].sort((a, b) => a.periode - b.periode);
        const last = sorted[sorted.length - 1];
        dashPemenang.className = 'winner-box';
        dashPemenang.innerHTML = `
            <div class="name">🏆 ${escapeHtml(last.nama)}</div>
            <div class="meta">Periode ${last.periode} • ${fmtDate(last.tanggal)}</div>
        `;
    }
}

// ======= PESERTA =======
function renderPeserta() {
    const tbody = document.getElementById('tbodyPeserta');
    const winnerSet = getWinnerSet();
    if (db.peserta.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Belum ada peserta. Klik "Tambah Peserta" untuk mulai.</td></tr>';
        return;
    }
    tbody.innerHTML = db.peserta.map((p, i) => {
        const menang = winnerSet.has(p.id);
        const statusBadge = menang
            ? '<span class="badge badge-menang">✓ Sudah Menang</span>'
            : '<span class="badge badge-belum">Belum</span>';
        const actions = isAdmin ? `
                    <button class="action-btn" data-action="edit" data-id="${p.id}">Edit</button>
                    <button class="action-btn danger" data-action="delete" data-id="${p.id}">Hapus</button>
        ` : '—';
        return `
            <tr>
                <td>${i + 1}</td>
                <td><b>${escapeHtml(p.nama)}</b></td>
                <td>${escapeHtml(p.hp || '—')}</td>
                <td>${escapeHtml(p.catatan || '—')}</td>
                <td>${statusBadge}</td>
                <td>${actions}</td>
            </tr>
        `;
    }).join('');
}

document.getElementById('tbodyPeserta').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'edit') openPesertaModal(id);
    else if (btn.dataset.action === 'delete') deletePeserta(id);
});

document.getElementById('btnAddPeserta').addEventListener('click', () => openPesertaModal(null));

function openPesertaModal(id) {
    editingPesertaId = id;
    const modal = document.getElementById('modalPeserta');
    const title = document.getElementById('modalTitle');
    const inpNama = document.getElementById('inpNama');
    const inpHp = document.getElementById('inpHp');
    const inpCatatan = document.getElementById('inpCatatan');

    if (id) {
        const p = db.peserta.find(x => x.id === id);
        title.textContent = 'Edit Peserta';
        inpNama.value = p.nama || '';
        inpHp.value = p.hp || '';
        inpCatatan.value = p.catatan || '';
    } else {
        title.textContent = 'Tambah Peserta';
        inpNama.value = '';
        inpHp.value = '';
        inpCatatan.value = '';
    }
    modal.hidden = false;
    setTimeout(() => inpNama.focus(), 50);
}

function closePesertaModal() {
    document.getElementById('modalPeserta').hidden = true;
    editingPesertaId = null;
}

document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', closePesertaModal);
});

document.getElementById('btnSavePeserta').addEventListener('click', async () => {
    const nama = document.getElementById('inpNama').value.trim();
    if (!nama) { toast('Nama wajib diisi', true); return; }
    const hp = document.getElementById('inpHp').value.trim();
    const catatan = document.getElementById('inpCatatan').value.trim();
    const btn = document.getElementById('btnSavePeserta');
    btn.disabled = true;
    try {
        if (editingPesertaId) {
            await dbUpdatePeserta(editingPesertaId, { nama, hp, catatan });
            toast('Peserta diupdate');
        } else {
            await dbAddPeserta({ nama, hp, catatan });
            toast('Peserta ditambahkan');
        }
        closePesertaModal();
        renderPeserta();
        renderDashboard();
    } catch (err) {
        toast('Gagal simpan: ' + err.message, true);
    } finally {
        btn.disabled = false;
    }
});

function deletePeserta(id) {
    const p = db.peserta.find(x => x.id === id);
    if (!p) return;
    const winnerSet = getWinnerSet();
    const extra = winnerSet.has(id) ? ' Riwayat kemenangannya juga akan dihapus.' : '';
    confirmAction(`Hapus peserta "${p.nama}"?${extra}`, async () => {
        try {
            await dbDeletePeserta(id);
            renderPeserta();
            renderDashboard();
            toast('Peserta dihapus');
        } catch (err) {
            toast('Gagal hapus: ' + err.message, true);
        }
    });
}

// ======= SETORAN =======
function renderSetoran() {
    document.getElementById('periodeView').textContent = periodeView;
    const tbody = document.getElementById('tbodySetoran');
    const sPer = db.setoran[periodeView] || {};

    if (db.peserta.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Belum ada peserta. Tambah peserta dulu.</td></tr>';
        document.getElementById('setoranSummary').innerHTML = '';
        return;
    }

    tbody.innerHTML = db.peserta.map((p, i) => {
        const bayar = !!sPer[p.id];
        const badge = bayar
            ? '<span class="badge badge-lunas">✓ Lunas</span>'
            : '<span class="badge badge-belum-bayar">Belum Bayar</span>';
        const btn = !isAdmin ? '—' : (bayar
            ? `<button class="action-btn danger" data-toggle="${p.id}">Batal</button>`
            : `<button class="action-btn" data-toggle="${p.id}">Tandai Lunas</button>`);
        return `
            <tr>
                <td>${i + 1}</td>
                <td><b>${escapeHtml(p.nama)}</b></td>
                <td>${fmtRp(db.settings.nominal)}</td>
                <td>${badge}</td>
                <td>${btn}</td>
            </tr>
        `;
    }).join('');

    const total = db.peserta.length;
    const bayar = db.peserta.filter(p => sPer[p.id]).length;
    const terkumpul = bayar * db.settings.nominal;
    const target = total * db.settings.nominal;
    document.getElementById('setoranSummary').innerHTML = `
        <div class="summary-box"><div class="lbl">Sudah Bayar</div><div class="val">${bayar} / ${total}</div></div>
        <div class="summary-box"><div class="lbl">Terkumpul</div><div class="val">${fmtRp(terkumpul)}</div></div>
        <div class="summary-box"><div class="lbl">Target</div><div class="val">${fmtRp(target)}</div></div>
        <div class="summary-box"><div class="lbl">Kurang</div><div class="val">${fmtRp(target - terkumpul)}</div></div>
    `;
}

document.getElementById('tbodySetoran').addEventListener('click', async e => {
    const btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    const id = btn.dataset.toggle;
    const wasBayar = !!(db.setoran[periodeView] || {})[id];
    btn.disabled = true;
    try {
        await dbSetSetoran(periodeView, id, !wasBayar);
        renderSetoran();
        renderDashboard();
    } catch (err) {
        toast('Gagal update: ' + err.message, true);
        btn.disabled = false;
    }
});

document.getElementById('periodePrev').addEventListener('click', () => {
    if (periodeView > 1) { periodeView--; renderSetoran(); }
});

document.getElementById('periodeNext').addEventListener('click', () => {
    if (periodeView < db.periodeAktif) { periodeView++; renderSetoran(); }
});

document.getElementById('btnNextPeriode').addEventListener('click', () => {
    confirmAction(`Mulai periode baru (${db.periodeAktif + 1})? Setoran periode baru akan kosong.`, async () => {
        try {
            await dbUpdateSettings({ periodeAktif: db.periodeAktif + 1 });
            periodeView = db.periodeAktif;
            renderSetoran();
            renderDashboard();
            toast(`Periode ${db.periodeAktif} dimulai`);
        } catch (err) {
            toast('Gagal: ' + err.message, true);
        }
    });
});

// ======= KOCOK (ROULETTE WHEEL) =======
const WHEEL_COLORS = ['#f97316', '#fbbf24', '#38bdf8', '#ef4444', '#22d3ee', '#a855f7', '#facc15', '#64748b', '#10b981', '#ec4899'];
const CANVAS_SIZE = 720;
let wheelRotation = 0;
let cachedKandidat = [];

function drawWheel(rotation, kandidat, highlightIdx = -1) {
    const canvas = document.getElementById('wheelCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = CANVAS_SIZE;
    const cx = size / 2, cy = size / 2;
    const radius = cx - 8;
    ctx.clearRect(0, 0, size, size);

    const n = kandidat.length;
    if (n === 0) return;
    const sliceAngle = (2 * Math.PI) / n;

    for (let i = 0; i < n; i++) {
        const startAngle = rotation - Math.PI / 2 + i * sliceAngle;
        const endAngle = startAngle + sliceAngle;
        const isHighlight = i === highlightIdx;

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = isHighlight ? '#fde047' : WHEEL_COLORS[i % WHEEL_COLORS.length];
        ctx.fill();
        ctx.strokeStyle = '#0f1419';
        ctx.lineWidth = 4;
        ctx.stroke();

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(startAngle + sliceAngle / 2);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#0f1419';
        const fontSize = Math.max(22, Math.min(44, 56 - n * 2));
        ctx.font = `700 ${fontSize}px Poppins, sans-serif`;
        const maxChars = n > 12 ? 8 : n > 8 ? 12 : 16;
        let text = kandidat[i].nama;
        if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…';
        ctx.fillText(text, radius - 30, 0);
        ctx.restore();
    }

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, 46, 0, 2 * Math.PI);
    ctx.fillStyle = '#1a2028';
    ctx.fill();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 6;
    ctx.stroke();
    // Inner dot
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, 2 * Math.PI);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
}

function renderKocok() {
    const winnerSet = getWinnerSet();
    const kandidat = db.peserta.filter(p => !winnerSet.has(p.id));
    cachedKandidat = kandidat;

    document.getElementById('kocokInfo').innerHTML = `
        Periode saat ini: <b>${db.periodeAktif}</b> •
        Kandidat: <b>${kandidat.length}</b> peserta •
        Hadiah: <b>${fmtRp(db.peserta.length * db.settings.nominal)}</b>
    `;

    const list = document.getElementById('kandidatList');
    if (kandidat.length === 0) {
        list.innerHTML = '<span class="empty">Tidak ada kandidat — semua sudah menang.</span>';
    } else {
        list.innerHTML = kandidat.map(p => `<span class="chip" data-id="${p.id}">${escapeHtml(p.nama)}</span>`).join('');
    }

    document.getElementById('wheelEmpty').hidden = kandidat.length > 0;
    wheelRotation = 0;
    drawWheel(wheelRotation, kandidat);

    const stage = document.getElementById('kocokStage');
    stage.classList.remove('done');
    document.getElementById('kocokDisplay').hidden = true;
    document.getElementById('kocokSub').textContent = kandidat.length === 0
        ? 'Tidak bisa kocok — semua peserta sudah menang'
        : 'Tekan tombol untuk mulai kocok';

    document.getElementById('btnKocok').hidden = false;
    document.getElementById('btnKocok').disabled = kandidat.length === 0;
    document.getElementById('btnSimpanMenang').hidden = true;
    document.getElementById('btnUlangKocok').hidden = true;
    currentWinnerId = null;
}

document.getElementById('btnKocok').addEventListener('click', startKocok);

function startKocok() {
    const kandidat = cachedKandidat;
    if (kandidat.length === 0) return;

    const winnerIdx = Math.floor(Math.random() * kandidat.length);
    const winner = kandidat[winnerIdx];
    currentWinnerId = winner.id;

    const sliceAngle = (2 * Math.PI) / kandidat.length;
    const jitter = (Math.random() - 0.5) * sliceAngle * 0.6;
    const baseR = -(winnerIdx + 0.5) * sliceAngle + jitter;
    const minR = wheelRotation + 5 * 2 * Math.PI;
    const k = Math.ceil((minR - baseR) / (2 * Math.PI));
    const targetR = baseR + k * 2 * Math.PI;

    document.getElementById('kocokSub').textContent = '🎡 Mengocok...';
    document.getElementById('btnKocok').disabled = true;
    document.getElementById('kocokDisplay').hidden = true;

    const startRot = wheelRotation;
    const duration = 4500 + Math.random() * 1000;
    const startTime = performance.now();

    function animate(now) {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / duration, 1);
        // easeOutQuart for natural spin slowdown
        const eased = 1 - Math.pow(1 - t, 4);
        wheelRotation = startRot + (targetR - startRot) * eased;
        drawWheel(wheelRotation, kandidat);

        if (t < 1) {
            kocokTimer = requestAnimationFrame(animate);
        } else {
            drawWheel(wheelRotation, kandidat, winnerIdx);
            const stage = document.getElementById('kocokStage');
            stage.classList.add('done');

            const disp = document.getElementById('kocokDisplay');
            disp.textContent = '🏆 ' + winner.nama;
            disp.hidden = false;

            document.getElementById('kocokSub').textContent = '🎉 Selamat! Pemenang periode ' + db.periodeAktif;
            document.getElementById('btnKocok').hidden = true;
            document.getElementById('btnSimpanMenang').hidden = false;
            document.getElementById('btnUlangKocok').hidden = false;

            const chips = document.querySelectorAll('#kandidatList .chip');
            chips.forEach(c => c.classList.toggle('winner', c.dataset.id === winner.id));
        }
    }
    kocokTimer = requestAnimationFrame(animate);
}

document.getElementById('btnSimpanMenang').addEventListener('click', async () => {
    if (!currentWinnerId) return;
    const p = db.peserta.find(x => x.id === currentWinnerId);
    if (!p) return;
    const existing = db.riwayat.find(r => r.periode === db.periodeAktif);
    const save = async () => {
        const jumlah = db.peserta.length * db.settings.nominal;
        try {
            await dbSaveWinner(db.periodeAktif, p, jumlah);
            toast(`${p.nama} dicatat sebagai pemenang periode ${db.periodeAktif}`);
            renderKocok();
            renderDashboard();
        } catch (err) {
            toast('Gagal simpan: ' + err.message, true);
        }
    };
    if (existing) {
        confirmAction(`Periode ${db.periodeAktif} sudah punya pemenang (${existing.nama}). Ganti?`, save);
    } else {
        save();
    }
});

document.getElementById('btnUlangKocok').addEventListener('click', () => {
    if (kocokTimer) cancelAnimationFrame(kocokTimer);
    renderKocok();
});

// ======= RIWAYAT =======
function renderRiwayat() {
    const tbody = document.getElementById('tbodyRiwayat');
    if (db.riwayat.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Belum ada riwayat pemenang.</td></tr>';
        return;
    }
    const sorted = [...db.riwayat].sort((a, b) => a.periode - b.periode);
    tbody.innerHTML = sorted.map(r => {
        const actions = isAdmin ? `<button class="action-btn danger" data-del-riwayat="${r.periode}">Hapus</button>` : '—';
        return `
        <tr>
            <td><b>Periode ${r.periode}</b></td>
            <td>${escapeHtml(r.nama)}</td>
            <td>${fmtDate(r.tanggal)}</td>
            <td>${fmtRp(r.jumlah || 0)}</td>
            <td>${actions}</td>
        </tr>
    `;
    }).join('');
}

document.getElementById('tbodyRiwayat').addEventListener('click', e => {
    const btn = e.target.closest('[data-del-riwayat]');
    if (!btn) return;
    const periode = Number(btn.dataset.delRiwayat);
    const r = db.riwayat.find(x => x.periode === periode);
    if (!r) return;
    confirmAction(`Hapus catatan pemenang periode ${periode} (${r.nama})?`, async () => {
        try {
            await dbDeleteRiwayat(periode);
            renderRiwayat();
            renderDashboard();
            toast('Riwayat dihapus');
        } catch (err) {
            toast('Gagal hapus: ' + err.message, true);
        }
    });
});

// ======= PENGATURAN =======
function renderPengaturan() {
    document.getElementById('setNama').value = db.settings.namaArisan;
    document.getElementById('setNominal').value = db.settings.nominal;
    document.getElementById('setPeriode').value = db.settings.periode;
    document.getElementById('setTanggal').value = db.settings.tanggalMulai;
    document.getElementById('setPeriodeAktif').value = db.periodeAktif;
}

['setNama', 'setNominal', 'setPeriode', 'setTanggal', 'setPeriodeAktif'].forEach(id => {
    document.getElementById(id).addEventListener('change', async () => {
        try {
            const newPeriodeAktif = Math.max(1, Number(document.getElementById('setPeriodeAktif').value) || 1);
            await dbUpdateSettings({
                namaArisan: document.getElementById('setNama').value.trim() || 'Arisan Saya',
                nominal: Number(document.getElementById('setNominal').value) || 0,
                periode: document.getElementById('setPeriode').value,
                tanggalMulai: document.getElementById('setTanggal').value,
                periodeAktif: newPeriodeAktif
            });
            periodeView = db.periodeAktif;
            updateBrand();
            renderDashboard();
            toast('Pengaturan disimpan');
        } catch (err) {
            toast('Gagal simpan: ' + err.message, true);
        }
    });
});

// ======= TAMBAH RIWAYAT MANUAL =======
document.getElementById('btnTambahRiwayat').addEventListener('click', () => {
    const select = document.getElementById('riwayatPeserta');
    select.innerHTML = '<option value="">— Pilih peserta —</option>' +
        db.peserta.map(p => `<option value="${p.id}">${escapeHtml(p.nama)}</option>`).join('');
    document.getElementById('riwayatTanggal').value = new Date().toISOString().slice(0, 10);
    document.getElementById('riwayatPeriode').value = '';
    document.getElementById('modalTambahRiwayat').hidden = false;
    setTimeout(() => document.getElementById('riwayatPeriode').focus(), 50);
});

document.querySelectorAll('[data-close-riwayat]').forEach(el => {
    el.addEventListener('click', () => {
        document.getElementById('modalTambahRiwayat').hidden = true;
    });
});

document.getElementById('btnSaveRiwayatManual').addEventListener('click', async () => {
    const periode = Number(document.getElementById('riwayatPeriode').value);
    const pesertaId = document.getElementById('riwayatPeserta').value;
    const tanggalInput = document.getElementById('riwayatTanggal').value;

    if (!periode || periode < 1) { toast('Periode harus angka valid', true); return; }
    if (!pesertaId) { toast('Pilih pemenang', true); return; }

    const peserta = db.peserta.find(p => p.id === pesertaId);
    if (!peserta) { toast('Peserta tidak ditemukan', true); return; }

    const tanggal = tanggalInput ? new Date(tanggalInput).toISOString() : new Date().toISOString();
    const jumlah = db.peserta.length * db.settings.nominal;
    const btn = document.getElementById('btnSaveRiwayatManual');
    btn.disabled = true;
    try {
        await dbSaveWinner(periode, peserta, jumlah);
        // Override tanggal dengan input user (dbSaveWinner pakai now())
        await sb.from('riwayat').update({ tanggal }).eq('periode', periode);
        const r = db.riwayat.find(x => x.periode === periode);
        if (r) r.tanggal = tanggal;
        toast(`${peserta.nama} dicatat sebagai pemenang periode ${periode}`);
        document.getElementById('modalTambahRiwayat').hidden = true;
        renderRiwayat();
        renderDashboard();
    } catch (err) {
        toast('Gagal simpan: ' + err.message, true);
    } finally {
        btn.disabled = false;
    }
});

function updateBrand() {
    document.getElementById('brandName').textContent = db.settings.namaArisan || 'Arisan Manager';
    const per = db.settings.periode === 'mingguan' ? 'Mingguan' : db.settings.periode === 'bulanan' ? 'Bulanan' : 'Custom';
    document.getElementById('brandSub').textContent = `${fmtRp(db.settings.nominal)} / ${per.toLowerCase()}`;
    document.title = db.settings.namaArisan || 'Arisan Manager';
}

// Export
document.getElementById('btnExport').addEventListener('click', () => {
    const data = JSON.stringify(db, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const fname = (db.settings.namaArisan || 'arisan').replace(/[^\w-]+/g, '_');
    a.download = `${fname}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Data di-export');
});

document.getElementById('btnImport').addEventListener('click', () => {
    toast('Import belum didukung di mode online — pakai Reset lalu tambah manual', true);
});

document.getElementById('btnReset').addEventListener('click', () => {
    confirmAction('Hapus SEMUA data dan mulai dari nol? Tindakan ini tidak bisa dibatalkan.', async () => {
        try {
            await dbResetAll();
            updateBrand();
            renderPengaturan();
            renderDashboard();
            switchTab('dashboard');
            toast('Data direset');
        } catch (err) {
            toast('Gagal reset: ' + err.message, true);
        }
    });
});

// ======= CONFIRM MODAL =======
let confirmCallback = null;

function confirmAction(msg, callback) {
    document.getElementById('confirmMsg').textContent = msg;
    document.getElementById('modalConfirm').hidden = false;
    confirmCallback = callback;
}

document.querySelectorAll('[data-close-confirm]').forEach(el => {
    el.addEventListener('click', () => {
        document.getElementById('modalConfirm').hidden = true;
        confirmCallback = null;
    });
});

document.getElementById('btnConfirmOk').addEventListener('click', () => {
    document.getElementById('modalConfirm').hidden = true;
    if (confirmCallback) { const cb = confirmCallback; confirmCallback = null; cb(); }
});

// ======= ADMIN LOGIN =======
document.getElementById('adminBtn').addEventListener('click', () => {
    if (isAdmin) {
        confirmAction('Keluar dari mode admin? Nanti kamu jadi read-only.', () => {
            isAdmin = false;
            localStorage.removeItem(ADMIN_KEY);
            applyAdminUI();
            const activeTab = document.querySelector('.tab.active')?.dataset.tab;
            if (activeTab === 'pengaturan') switchTab('dashboard');
            else if (activeTab) switchTab(activeTab);
            toast('Keluar dari admin mode');
        });
    } else {
        document.getElementById('modalAdmin').hidden = false;
        setTimeout(() => document.getElementById('adminPwd').focus(), 50);
    }
});

document.querySelectorAll('[data-close-admin]').forEach(el => {
    el.addEventListener('click', () => {
        document.getElementById('modalAdmin').hidden = true;
        document.getElementById('adminPwd').value = '';
    });
});

async function tryAdminLogin() {
    const pwd = document.getElementById('adminPwd').value;
    if (!pwd) { toast('Isi password', true); return; }
    const inputHash = await hashPassword(pwd);
    const expected = await getExpectedHash();
    if (inputHash === expected) {
        isAdmin = true;
        localStorage.setItem(ADMIN_KEY, 'yes');
        applyAdminUI();
        document.getElementById('modalAdmin').hidden = true;
        document.getElementById('adminPwd').value = '';
        const activeTab = document.querySelector('.tab.active')?.dataset.tab;
        if (activeTab) switchTab(activeTab);
        toast('Admin mode aktif 🔓');
    } else {
        toast('Password salah', true);
        document.getElementById('adminPwd').select();
    }
}

async function changeAdminPassword(oldPwd, newPwd) {
    const inputHash = await hashPassword(oldPwd);
    const expected = await getExpectedHash();
    if (inputHash !== expected) throw new Error('Password lama salah');
    if (!newPwd || newPwd.length < 4) throw new Error('Password baru minimal 4 karakter');
    const newHash = await hashPassword(newPwd);
    const { error } = await sb.from('settings').update({ admin_hash: newHash }).eq('id', 1);
    if (error) throw error;
    adminHash = newHash;
}

document.getElementById('btnAdminLogin').addEventListener('click', tryAdminLogin);
document.getElementById('adminPwd').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryAdminLogin();
});

document.getElementById('btnChangePwd').addEventListener('click', async () => {
    const oldPwd = document.getElementById('pwdOld').value;
    const newPwd = document.getElementById('pwdNew').value;
    const confirmPwd = document.getElementById('pwdConfirm').value;
    if (newPwd !== confirmPwd) { toast('Konfirmasi password tidak cocok', true); return; }
    const btn = document.getElementById('btnChangePwd');
    btn.disabled = true;
    try {
        await changeAdminPassword(oldPwd, newPwd);
        document.getElementById('pwdOld').value = '';
        document.getElementById('pwdNew').value = '';
        document.getElementById('pwdConfirm').value = '';
        toast('Password berhasil diganti 🔐');
    } catch (err) {
        toast(err.message, true);
    } finally {
        btn.disabled = false;
    }
});

// ======= CHAT =======
const CHAT_NAME_KEY = 'arisan-chat-name';
let chatName = localStorage.getItem(CHAT_NAME_KEY) || '';
let chatUnread = 0;

function chatRenderArea() {
    const setup = document.getElementById('chatNameSetup');
    const form = document.getElementById('chatForm');
    const messages = document.getElementById('chatMessages');
    const footer = document.getElementById('chatFooter');
    if (chatName) {
        setup.hidden = true;
        form.hidden = false;
        messages.style.display = 'flex';
        footer.hidden = false;
        document.getElementById('chatCurrentName').textContent = chatName;
    } else {
        setup.hidden = false;
        form.hidden = true;
        messages.style.display = 'none';
        footer.hidden = true;
    }
}

function chatEscapeMsg(m) {
    const mine = m.nama === chatName;
    const when = new Date(m.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    return `
        <div class="chat-msg ${mine ? 'mine' : ''}">
            ${mine ? '' : `<div class="who">${escapeHtml(m.nama)}</div>`}
            <span class="text">${escapeHtml(m.pesan)}</span>
            <span class="when">${when}</span>
        </div>
    `;
}

function chatScrollBottom() {
    const el = document.getElementById('chatMessages');
    el.scrollTop = el.scrollHeight;
}

async function chatLoadMessages() {
    const { data, error } = await sb.from('chat')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(200);
    if (error) { console.error('chat load:', error); return; }
    const container = document.getElementById('chatMessages');
    if (!data || data.length === 0) {
        container.innerHTML = '<div class="chat-empty">Belum ada pesan.<br>Mulai chat dulu! 👋</div>';
    } else {
        container.innerHTML = data.map(chatEscapeMsg).join('');
    }
    chatScrollBottom();
}

function chatUpdateUnread() {
    const badge = document.getElementById('chatUnread');
    if (chatUnread > 0) {
        badge.textContent = chatUnread > 99 ? '99+' : chatUnread;
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
}

function chatSubscribeRealtime() {
    sb.channel('chat-live')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat' }, (payload) => {
            const container = document.getElementById('chatMessages');
            const empty = container.querySelector('.chat-empty');
            if (empty) container.innerHTML = '';
            container.insertAdjacentHTML('beforeend', chatEscapeMsg(payload.new));
            chatScrollBottom();
            if (document.getElementById('chatWidget').classList.contains('collapsed') && payload.new.nama !== chatName) {
                chatUnread++;
                chatUpdateUnread();
            }
        })
        .subscribe();
}

function setupChat() {
    const widget = document.getElementById('chatWidget');
    const head = document.getElementById('chatHead');

    head.addEventListener('click', () => {
        widget.classList.toggle('collapsed');
        if (!widget.classList.contains('collapsed')) {
            chatUnread = 0;
            chatUpdateUnread();
            chatScrollBottom();
            if (chatName) document.getElementById('chatInput').focus();
            else document.getElementById('chatNameInput').focus();
        }
    });

    document.getElementById('chatNameSave').addEventListener('click', () => {
        const val = document.getElementById('chatNameInput').value.trim();
        if (!val) { toast('Nama harus diisi', true); return; }
        chatName = val;
        localStorage.setItem(CHAT_NAME_KEY, val);
        chatRenderArea();
        chatLoadMessages();
        document.getElementById('chatInput').focus();
    });

    document.getElementById('chatNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('chatNameSave').click();
    });

    document.getElementById('chatChangeName').addEventListener('click', (e) => {
        e.preventDefault();
        const newName = prompt('Nama baru:', chatName);
        if (newName && newName.trim()) {
            chatName = newName.trim();
            localStorage.setItem(CHAT_NAME_KEY, chatName);
            chatRenderArea();
            chatLoadMessages();
        }
    });

    document.getElementById('chatForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!chatName) return;
        const inp = document.getElementById('chatInput');
        const msg = inp.value.trim();
        if (!msg) return;
        inp.value = '';
        try {
            const { error } = await sb.from('chat').insert({ nama: chatName, pesan: msg });
            if (error) throw error;
        } catch (err) {
            toast('Gagal kirim: ' + err.message, true);
            inp.value = msg;
        }
    });

    chatRenderArea();
    chatLoadMessages();
    chatSubscribeRealtime();
}

// ======= INIT =======
(async () => {
    setLoading(true, 'Menghubungkan ke database...');
    applyAdminUI();
    try {
        await loadAll();
        periodeView = db.periodeAktif;
        updateBrand();
        renderPengaturan();
        renderDashboard();
        subscribeRealtime();
        setupChat();
        setLoading(false);
    } catch (err) {
        console.error(err);
        setLoading(true, 'Gagal konek: ' + err.message);
        toast('Gagal load data: ' + err.message, true);
    }
})();
