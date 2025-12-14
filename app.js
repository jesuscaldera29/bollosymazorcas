const money = (n) => (Number(n||0)).toLocaleString("es-CO");
const todayISO = () => new Date().toISOString().slice(0,10);
const now = () => Date.now();
const VIEWS = ["login","dash","products","customers","sales","payments","routes","map","users","config"];
const el = (id) => document.getElementById(id);

let state = {
  session: null,
  config: {
    mapsKey:"", syncMode:"local", sbUrl:"", sbKey:"",
    centerLat: 9.236, centerLng: -75.814,
    trackSave: 1
  },
  me: { lat:null, lng:null }
};

const mapState = {
  map: null,
  info: null,
  markers: [],
  meMarker: null,
  directionsService: null,
  directionsRenderer: null,
  lastDirections: null,
  lastRouteLegs: null,
  selectedIds: new Set(),
  liveWatchId: null,
  liveMarker: null,
  livePath: [],
  livePolyline: null
};

window.addEventListener("load", async () => {
  await boot();
  setupUI();
  await refreshAll();
  registerSW();
  updateOnlinePill();
});

window.addEventListener("online", () => { updateOnlinePill(); if(state.session) refreshMap(); });
window.addEventListener("offline", () => { updateOnlinePill(); if(state.session) refreshMap(); });

function updateOnlinePill(){
  el("onlinePill").textContent = navigator.onLine ? "🟢 Online" : "🔴 Offline";
}

async function boot(){
  const cfg = await DB.get("meta","config");
  if (cfg?.value) state.config = { ...state.config, ...cfg.value };

  // Admin fijo
  const adminId = "admin-fixed";
  const admin = await DB.get("users", adminId);
  if(!admin){
    await DB.put("users", {
      id: adminId, role:"admin", name:"Administrador",
      email:"admin@bollos.com", pass:"12345", active:1, createdAt: now()
    });
  }

  // Seed productos
  const products = await DB.all("products");
  if(products.length === 0){
    await DB.put("products", { id: DB.id(), name:"Bollo", price:1000, cost:0, active:1, desc:"", createdAt: now(), updatedAt: now() });
    await DB.put("products", { id: DB.id(), name:"Mazorca", price:1000, cost:0, active:1, desc:"", createdAt: now(), updatedAt: now() });
  }

  // Auto-login
  const sess = await DB.get("meta","session");
  if(sess?.value) state.session = sess.value;
}

function setupUI(){
  el("bottomNav").addEventListener("click", (e)=>{
    const b = e.target.closest("button[data-view]");
    if(!b) return;
    const v = b.dataset.view;
    if(v==="more"){ openMore(); return; }
    go(v);
  });

  document.body.addEventListener("click", (e)=>{
    const b = e.target.closest("button[data-nav]");
    if(!b) return;
    go(b.dataset.nav);
  });

  // Login
  el("btnLogin").onclick = doLogin;
  el("btnLogout").onclick = doLogout;

  // Products
  el("btnNewProduct").onclick = () => openProductForm(null);
  el("btnCancelProduct").onclick = () => openProductForm(null, true);
  el("btnSaveProduct").onclick = saveProduct;
  el("btnDeleteProduct").onclick = deleteProduct;

  // Customers
  el("btnNewCustomer").onclick = () => openCustomerForm(null);
  el("btnCancelCustomer").onclick = () => openCustomerForm(null, true);
  el("btnSaveCustomer").onclick = saveCustomer;
  el("btnDeleteCustomer").onclick = deleteCustomer;
  el("btnGetGPSCustomer").onclick = saveCustomerGPSHere;
  el("custSearch").oninput = renderCustomers;
  el("custFilterDebt").onchange = renderCustomers;

  // Sales
  el("saleQty").oninput = calcSaleTotal;
  el("saleProduct").onchange = calcSaleTotal;
  el("btnSaveSale").onclick = saveSale;

  // Payments
  el("btnSavePayment").onclick = savePayment;
  el("payCustomer").onchange = renderPaymentInfo;

  // Routes
  el("btnNewRoute").onclick = openRouteBuilder;
  el("btnCancelRoute").onclick = closeRouteBuilder;
  el("btnSaveRoute").onclick = saveRoute;
  el("btnCloseRouteDetail").onclick = () => el("routeDetail").classList.add("hidden");

  // Dashboard
  el("btnCSV").onclick = exportCSVBundle;
  el("btnSync").onclick = syncNow;

  // Users (Admin)
  el("btnNewUser").onclick = () => openUserForm(null);
  el("btnCancelUser").onclick = () => openUserForm(null, true);
  el("btnSaveUser").onclick = saveUser;
  el("btnDeleteUser").onclick = deleteUser;

  // Config
  el("btnSaveConfig").onclick = saveConfig;

  // Map actions
  el("btnLocateMe").onclick = () => locateMe(true).then(refreshMap);
  el("btnBuildRoute").onclick = buildRouteFromSelection;
  el("btnSaveBuiltRoute").onclick = saveBuiltRouteToModule;
  el("btnLiveRoute").onclick = startLiveTracking;
  el("btnStopLive").onclick = stopLiveTracking;
}

async function refreshAll(){
  if(state.session){
    await afterLoginUI();
    go("dash");
  }else{
    go("login");
  }
}

function go(view){
  if(view!=="login" && !state.session) return go("login");

  for(const v of VIEWS){
    const node = el("view"+cap(v));
    if(node) node.classList.add("hidden");
  }

  if(view==="login"){
    el("viewLogin").classList.remove("hidden");
    el("bottomNav").classList.add("hidden");
    el("btnLogout").classList.add("hidden");
    el("userPill").classList.add("hidden");
    return;
  }

  el("bottomNav").classList.remove("hidden");
  el("btnLogout").classList.remove("hidden");
  el("userPill").classList.remove("hidden");

  for(const b of el("bottomNav").querySelectorAll("button[data-view]")){
    b.classList.toggle("active", b.dataset.view===view);
  }

  const node = el("view"+cap(view));
  if(node) node.classList.remove("hidden");

  if(view==="dash") renderDashboard();
  if(view==="products") renderProducts();
  if(view==="customers") renderCustomers();
  if(view==="sales") renderSalesForm();
  if(view==="payments") renderPaymentsForm();
  if(view==="routes") renderRoutes();
  if(view==="map") refreshMap();
  if(view==="users") renderUsers();
  if(view==="config") renderConfig();
}

function openMore(){
  if(state.session?.role === "admin") go("users");
  else go("routes");
}

function cap(s){ return s.charAt(0).toUpperCase()+s.slice(1); }

// ---------------- AUTH ----------------
let loginAttempts = 0;
let lockUntil = 0;

async function doLogin(){
  const email = el("loginEmail").value.trim().toLowerCase();
  const pass = el("loginPass").value.trim();
  const msg = el("loginMsg");

  if(Date.now() < lockUntil){
    msg.textContent = "Bloqueado por intentos. Espera 30s.";
    return;
  }
  msg.textContent = "";

  const users = await DB.all("users");
  const user = users.find(u => u.email.toLowerCase()===email);

  if(!user || user.pass !== pass || user.active !== 1){
    loginAttempts++;
    if(loginAttempts >= 5){
      lockUntil = Date.now() + 30000;
      loginAttempts = 0;
      msg.textContent = "Demasiados intentos. Bloqueado 30 segundos.";
      return;
    }
    msg.textContent = "Credenciales inválidas.";
    return;
  }

  state.session = { userId: user.id, role: user.role, name: user.name, email: user.email };
  await DB.put("meta", { key:"session", value: state.session });

  await afterLoginUI();
  go("dash");
}

async function afterLoginUI(){
  const s = state.session;
  el("userPill").textContent = `${s.role.toUpperCase()} · ${s.name}`;
  el("subTitle").textContent = s.role === "admin" ? "Admin" : "Vendedor";
}

async function doLogout(){
  stopLiveTracking();
  state.session = null;
  await DB.del("meta","session");
  go("login");
}

// ---------------- CONFIG ----------------
function requireAdmin(){
  if(state.session?.role !== "admin"){
    alert("Solo Admin.");
    throw new Error("Admin only");
  }
}

async function renderConfig(){
  requireAdmin();
  el("cfgMapsKey").value = state.config.mapsKey || "";
  el("cfgSyncMode").value = state.config.syncMode || "local";
  el("cfgSbUrl").value = state.config.sbUrl || "";
  el("cfgSbKey").value = state.config.sbKey || "";
  el("cfgCenterLat").value = state.config.centerLat ?? 9.236;
  el("cfgCenterLng").value = state.config.centerLng ?? -75.814;
  el("cfgTrackSave").value = String(state.config.trackSave ?? 1);
  el("cfgMsg").textContent = "";
}

async function saveConfig(){
  requireAdmin();
  state.config.mapsKey = el("cfgMapsKey").value.trim();
  state.config.syncMode = el("cfgSyncMode").value;
  state.config.sbUrl = el("cfgSbUrl").value.trim();
  state.config.sbKey = el("cfgSbKey").value.trim();
  state.config.centerLat = Number(el("cfgCenterLat").value || 9.236);
  state.config.centerLng = Number(el("cfgCenterLng").value || -75.814);
  state.config.trackSave = Number(el("cfgTrackSave").value || 1);

  await DB.put("meta", { key:"config", value: state.config });
  el("cfgMsg").textContent = "Guardado.";
  refreshMap();
}

// ---------------- PRODUCTS ----------------
let editingProductId = null;

async function renderProducts(){
  const isAdmin = state.session?.role === "admin";
  el("btnNewProduct").disabled = !isAdmin;

  const list = (await DB.all("products")).sort((a,b)=>a.name.localeCompare(b.name));
  const tb = el("productTable");
  tb.innerHTML = "";

  for(const p of list){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(p.name)}</td>
      <td>$${money(p.price)}</td>
      <td>$${money(p.cost||0)}</td>
      <td>${p.active?'<span class="tag good">Activo</span>':'<span class="tag bad">Inactivo</span>'}</td>
      <td><button class="btn" ${isAdmin?'':'disabled'} data-edit-product="${p.id}">Editar</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("button[data-edit-product]").forEach(b=>{
    b.onclick = async ()=> openProductForm(b.dataset.editProduct);
  });

  openProductForm(null, true);
}

async function openProductForm(productId, forceClose=false){
  const isAdmin = state.session?.role === "admin";
  const form = el("productForm");
  if(forceClose || !isAdmin){
    form.classList.add("hidden");
    editingProductId = null;
    return;
  }

  form.classList.remove("hidden");
  el("btnDeleteProduct").classList.toggle("hidden", !productId);

  if(!productId){
    editingProductId = null;
    el("pName").value = "";
    el("pPrice").value = "";
    el("pCost").value = "";
    el("pActive").value = "1";
    el("pDesc").value = "";
    return;
  }

  const p = await DB.get("products", productId);
  if(!p) return;
  editingProductId = p.id;
  el("pName").value = p.name;
  el("pPrice").value = p.price;
  el("pCost").value = p.cost||0;
  el("pActive").value = p.active ? "1" : "0";
  el("pDesc").value = p.desc||"";
}

async function saveProduct(){
  requireAdmin();
  const name = el("pName").value.trim();
  const price = Number(el("pPrice").value||0);
  const cost = Number(el("pCost").value||0);
  const active = el("pActive").value === "1" ? 1 : 0;
  const desc = el("pDesc").value.trim();

  if(!name || price<=0){ alert("Nombre y precio válidos."); return; }

  if(editingProductId){
    const p = await DB.get("products", editingProductId);
    const updated = { ...p, name, price, cost, active, desc, updatedAt: now() };
    await DB.put("products", updated);
    await DB.queue("upsert_product", updated);
  }else{
    const p = { id: DB.id(), name, price, cost, active, desc, createdAt: now(), updatedAt: now() };
    await DB.put("products", p);
    await DB.queue("upsert_product", p);
  }

  await renderProducts();
  await renderSalesForm();
  await renderDashboard();
}

async function deleteProduct(){
  requireAdmin();
  if(!editingProductId) return;
  if(!confirm("¿Eliminar producto?")) return;
  await DB.del("products", editingProductId);
  await DB.queue("delete_product", { id: editingProductId });
  editingProductId = null;
  await renderProducts();
  await renderSalesForm();
  await renderDashboard();
}

// ---------------- CUSTOMERS ----------------
let editingCustomerId = null;

async function renderCustomers(){
  const q = el("custSearch").value.trim().toLowerCase();
  const f = el("custFilterDebt").value;

  const customers = (await DB.all("customers")).sort((a,b)=> (a.name||"").localeCompare(b.name||""));
  const debts = await computeCustomerDebts();
  const tb = el("customerTable");
  tb.innerHTML = "";

  const filtered = customers.filter(c=>{
    const hay = `${c.name||""} ${c.phone||""} ${c.addr||""}`.toLowerCase();
    if(q && !hay.includes(q)) return false;

    const pending = debts[c.id] || 0;
    if(f==="debt" && pending<=0) return false;
    if(f==="ok" && pending>0) return false;
    return true;
  });

  for(const c of filtered){
    const pending = debts[c.id] || 0;
    const status = pending>0 ? `<span class="tag bad">Con deuda: $${money(pending)}</span>` : `<span class="tag good">Al día</span>`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(c.name||"")}</td>
      <td>${esc(c.phone||"")}</td>
      <td>${esc(c.addr||"")}</td>
      <td>${status}</td>
      <td><button class="btn" data-edit-customer="${c.id}">Editar</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("button[data-edit-customer]").forEach(b=>{
    b.onclick = () => openCustomerForm(b.dataset.editCustomer);
  });

  openCustomerForm(null, true);
  await renderSalesForm();
  await renderPaymentsForm();
}

async function openCustomerForm(customerId, forceClose=false){
  const form = el("customerForm");
  if(forceClose){
    form.classList.add("hidden");
    editingCustomerId = null;
    return;
  }
  form.classList.remove("hidden");
  el("btnDeleteCustomer").classList.toggle("hidden", !customerId);
  el("gpsMsg").textContent = "";

  if(!customerId){
    editingCustomerId = null;
    el("cName").value=""; el("cPhone").value="";
    el("cAddr").value=""; el("cRef").value="";
    el("cNotes").value="";
    el("cLat").value=""; el("cLng").value="";
    return;
  }

  const c = await DB.get("customers", customerId);
  if(!c) return;
  editingCustomerId = c.id;
  el("cName").value=c.name||"";
  el("cPhone").value=c.phone||"";
  el("cAddr").value=c.addr||"";
  el("cRef").value=c.ref||"";
  el("cNotes").value=c.notes||"";
  el("cLat").value=c.lat ?? "";
  el("cLng").value=c.lng ?? "";
}

async function saveCustomer(){
  const name = el("cName").value.trim();
  if(!name){ alert("Nombre requerido."); return; }

  const obj = {
    name,
    phone: el("cPhone").value.trim(),
    addr: el("cAddr").value.trim(),
    ref: el("cRef").value.trim(),
    notes: el("cNotes").value.trim(),
    lat: parseFloat(el("cLat").value || ""),
    lng: parseFloat(el("cLng").value || ""),
    updatedAt: now()
  };

  if(editingCustomerId){
    const c = await DB.get("customers", editingCustomerId);
    const updated = { ...c, ...obj };
    await DB.put("customers", updated);
    await DB.queue("upsert_customer", updated);
  }else{
    const c = { id: DB.id(), ...obj, createdAt: now(), ownerId: state.session.userId };
    await DB.put("customers", c);
    await DB.queue("upsert_customer", c);
  }

  await renderCustomers();
  await renderDashboard();
  await refreshMap();
}

async function deleteCustomer(){
  if(!editingCustomerId) return;
  if(!confirm("¿Eliminar cliente?")) return;
  await DB.del("customers", editingCustomerId);
  await DB.queue("delete_customer", { id: editingCustomerId });
  editingCustomerId = null;
  await renderCustomers();
  await renderDashboard();
  await refreshMap();
}

async function saveCustomerGPSHere(){
  el("gpsMsg").textContent = "Obteniendo GPS...";
  try{
    const pos = await getGPS();
    el("cLat").value = pos.lat;
    el("cLng").value = pos.lng;
    el("gpsMsg").textContent = "Ubicación guardada.";
  }catch(e){
    el("gpsMsg").textContent = "No se pudo obtener GPS. Revisa permisos.";
  }
}

// ---------------- SALES ----------------
async function renderSalesForm(){
  const customers = (await DB.all("customers")).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const products = (await DB.all("products")).filter(p=>p.active).sort((a,b)=>a.name.localeCompare(b.name));

  el("saleCustomer").innerHTML = customers.map(c=>`<option value="${c.id}">${esc(c.name||"")}</option>`).join("") || `<option value="">(Crea un cliente)</option>`;
  el("saleProduct").innerHTML = products.map(p=>`<option value="${p.id}" data-price="${p.price}">${esc(p.name)} · $${money(p.price)}</option>`).join("") || `<option value="">(No hay productos activos)</option>`;

  el("saleQty").value = 1;
  el("saleType").value = "cash";
  el("saleNote").value = "";
  calcSaleTotal();
}

async function calcSaleTotal(){
  const opt = el("saleProduct").selectedOptions[0];
  const price = Number(opt?.dataset?.price || 0);
  const qty = Number(el("saleQty").value || 0);
  el("saleTotal").value = "$" + money(price * qty);
}

async function saveSale(){
  const msg = el("saleMsg");
  msg.textContent = "";

  const customerId = el("saleCustomer").value;
  const productId = el("saleProduct").value;
  const qty = Number(el("saleQty").value||0);
  const type = el("saleType").value;
  const note = el("saleNote").value.trim();

  if(!customerId){ msg.textContent="Crea/selecciona cliente."; return; }
  if(!productId){ msg.textContent="Selecciona producto."; return; }
  if(qty<=0){ msg.textContent="Cantidad inválida."; return; }

  const p = await DB.get("products", productId);
  const total = Number(p.price) * qty;

  const saleId = DB.id();
  const sale = {
    id: saleId, customerId, type, total, note,
    createdAt: now(), createdBy: state.session.userId
  };
  const item = { id: DB.id(), saleId, productId, qty, price: p.price, cost: p.cost||0 };

  await DB.put("sales", sale);
  await DB.put("sale_items", item);
  await DB.queue("upsert_sale", { sale, item });

  msg.textContent = "Venta guardada.";
  await renderDashboard();
  await renderCustomers();
  await renderPaymentsForm();
  await refreshMap();
}

// ---------------- PAYMENTS ----------------
async function renderPaymentsForm(){
  const debts = await computeCustomerDebts();
  const customers = (await DB.all("customers")).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  customers.sort((a,b)=> (debts[b.id]||0) - (debts[a.id]||0));

  el("payCustomer").innerHTML = customers.map(c=>{
    const d = debts[c.id]||0;
    const label = d>0 ? `${c.name} · deuda $${money(d)}` : `${c.name} · al día`;
    return `<option value="${c.id}">${esc(label)}</option>`;
  }).join("");

  el("payAmount").value = "";
  el("payNote").value = "";
  await renderPaymentInfo();
}

async function renderPaymentInfo(){
  const cid = el("payCustomer").value;
  const debts = await computeCustomerDebts();
  const d = debts[cid]||0;
  el("payInfo").innerHTML = d>0
    ? `Saldo pendiente actual: <b>$${money(d)}</b>. Puedes abonar parcial o total.`
    : `Este cliente está <b>al día</b>.`;
}

async function savePayment(){
  const msg = el("payMsg");
  msg.textContent = "";

  const customerId = el("payCustomer").value;
  const amount = Number(el("payAmount").value||0);
  const note = el("payNote").value.trim();

  if(!customerId){ msg.textContent="Selecciona cliente."; return; }
  if(amount<=0){ msg.textContent="Monto inválido."; return; }

  const payment = {
    id: DB.id(), customerId, amount, note,
    createdAt: now(), createdBy: state.session.userId
  };
  await DB.put("payments", payment);
  await DB.queue("upsert_payment", payment);

  msg.textContent = "Abono guardado.";
  await renderDashboard();
  await renderCustomers();
  await renderPaymentsForm();
  await refreshMap();
}

// ---------------- ROUTES (module) ----------------
let buildingRoute = false;
let currentRouteId = null;

async function openRouteBuilder(){
  buildingRoute = true;
  el("routeBuilder").classList.remove("hidden");
  el("routeDetail").classList.add("hidden");
  el("rDate").value = todayISO();
  el("rName").value = "Ruta " + new Date().toLocaleDateString("es-CO");

  const debts = await computeCustomerDebts();
  const customers = (await DB.all("customers")).sort((a,b)=>(a.name||"").localeCompare(b.name||""));

  const box = el("routeCustomerChecklist");
  box.innerHTML = "";
  for(const c of customers){
    const d = debts[c.id]||0;
    const row = document.createElement("div");
    row.style.display="flex";
    row.style.gap="10px";
    row.style.alignItems="center";
    row.style.padding="8px";
    row.style.borderBottom="1px solid rgba(31,42,68,.6)";
    row.innerHTML = `
      <input type="checkbox" data-cid="${c.id}" ${d>0?'checked':''}/>
      <div style="flex:1">
        <div><b>${esc(c.name||"")}</b></div>
        <div class="muted">Deuda: $${money(d)} · ${esc(c.addr||"")}</div>
      </div>
      <span class="tag ${d>0?'bad':'good'}">${d>0?'Con deuda':'Al día'}</span>
    `;
    box.appendChild(row);
  }
}

function closeRouteBuilder(){
  buildingRoute = false;
  el("routeBuilder").classList.add("hidden");
}

async function saveRoute(){
  const name = el("rName").value.trim();
  const date = el("rDate").value || todayISO();
  if(!name){ alert("Nombre ruta requerido."); return; }

  const checks = [...el("routeCustomerChecklist").querySelectorAll("input[type=checkbox][data-cid]")];
  const selected = checks.filter(c=>c.checked).map(c=>c.dataset.cid);
  if(selected.length===0){ alert("Selecciona al menos 1 cliente."); return; }

  const routeId = DB.id();
  const route = {
    id: routeId, name, date,
    createdAt: now(), createdBy: state.session.userId,
    status:"activa",
    source:"manual",
    km:null, minutes:null
  };
  await DB.put("routes", route);

  let i=1;
  for(const cid of selected){
    await DB.put("route_stops", {
      id: DB.id(), routeId, order: i++,
      customerId: cid, state: "Pendiente", updatedAt: now()
    });
  }

  await DB.queue("upsert_route", { route });
  closeRouteBuilder();
  await renderRoutes();
}

async function renderRoutes(){
  const routes = (await DB.all("routes")).sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  const stops = await DB.all("route_stops");

  const tb = el("routeTable");
  tb.innerHTML = "";

  for(const r of routes){
    const s = stops.filter(x=>x.routeId===r.id);
    const pending = s.filter(x=>x.state==="Pendiente").length;
    const done = s.filter(x=>x.state==="Cobrado").length;
    const tag = pending>0 ? `<span class="tag warn">${done}/${s.length} cobrado</span>` : `<span class="tag good">Completada</span>`;
    const extra = (r.km!=null && r.minutes!=null) ? ` · ${r.km} km · ${r.minutes} min` : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(r.name||"")}${extra}</td>
      <td>${esc(r.date||"")}</td>
      <td>${s.length}</td>
      <td>${tag}</td>
      <td><button class="btn" data-open-route="${r.id}">Abrir</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("button[data-open-route]").forEach(b=>{
    b.onclick = ()=> openRouteDetail(b.dataset.openRoute);
  });

  closeRouteBuilder();
}

async function openRouteDetail(routeId){
  currentRouteId = routeId;
  el("routeDetail").classList.remove("hidden");
  closeRouteBuilder();

  const route = await DB.get("routes", routeId);
  const stops = (await DB.where("route_stops", s=>s.routeId===routeId)).sort((a,b)=>a.order-b.order);
  const debts = await computeCustomerDebts();
  const customers = await DB.all("customers");

  el("routeDetailMeta").textContent = `${route.name} · ${route.date}`;

  const tb = el("routeStopsTable");
  tb.innerHTML = "";

  for(const s of stops){
    const c = customers.find(x=>x.id===s.customerId);
    const pending = debts[s.customerId]||0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.order}</td>
      <td>${esc(c?.name||"")}</td>
      <td>$${money(pending)}</td>
      <td>
        <select class="input" data-stop-state="${s.id}">
          ${["Pendiente","Cobrado","No estaba","Reprogramado"].map(v=>`<option ${s.state===v?'selected':''}>${v}</option>`).join("")}
        </select>
      </td>
      <td class="row" style="gap:8px">
        <button class="btn pri" data-stop-pay="${s.customerId}">Cobrar</button>
        <button class="btn" data-stop-nav="${s.customerId}">Navegar</button>
      </td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("select[data-stop-state]").forEach(sel=>{
    sel.onchange = async ()=>{
      const stopId = sel.dataset.stopState;
      const st = await DB.get("route_stops", stopId);
      st.state = sel.value;
      st.updatedAt = now();
      await DB.put("route_stops", st);
      await DB.queue("upsert_route_stop", st);
      await renderRoutes();
    };
  });

  tb.querySelectorAll("button[data-stop-pay]").forEach(btn=>{
    btn.onclick = async ()=>{
      const cid = btn.dataset.stopPay;
      go("payments");
      el("payCustomer").value = cid;
      await renderPaymentInfo();
    };
  });

  tb.querySelectorAll("button[data-stop-nav]").forEach(btn=>{
    btn.onclick = ()=> navigateToCustomer(btn.dataset.stopNav);
  });
}

// ---------------- DASHBOARD ----------------
async function renderDashboard(){
  const sales = await DB.all("sales");
  const items = await DB.all("sale_items");
  const payments = await DB.all("payments");

  const debts = await computeCustomerDebts();
  const pendingTotal = Object.values(debts).reduce((a,b)=>a+(Number(b)||0),0);

  const today = todayISO();
  const salesToday = sales.filter(s=> new Date(s.createdAt).toISOString().slice(0,10)===today);
  const paidToday = payments.filter(p=> new Date(p.createdAt).toISOString().slice(0,10)===today);

  const salesTodaySum = salesToday.reduce((a,s)=>a+Number(s.total||0),0);
  const paidTodaySum = paidToday.reduce((a,p)=>a+Number(p.amount||0),0);

  let profit = 0;
  for(const it of items){
    const sale = sales.find(s=>s.id===it.saleId);
    if(!sale) continue;
    const day = new Date(sale.createdAt).toISOString().slice(0,10);
    if(day !== today) continue;
    const unitProfit = (Number(it.price||0) - Number(it.cost||0));
    profit += unitProfit * Number(it.qty||0);
  }

  el("kSalesToday").textContent = "$" + money(salesTodaySum);
  el("kPaidToday").textContent = "$" + money(paidTodaySum);
  el("kPending").textContent = "$" + money(pendingTotal);
  el("kProfit").textContent = "$" + money(profit);

  el("dashNote").innerHTML =
    `Estado: <b>${navigator.onLine ? "Online" : "Offline"}</b>. Todo se guarda offline. ` +
    `Para calles/rutas reales en el mapa: internet + API Key + Directions API.`;
}

// ---------------- MAP (Real) ----------------
async function refreshMap(){
  // Carga deudores
  const debts = await computeCustomerDebts();
  const customersAll = await DB.all("customers");
  const debtCustomers = customersAll
    .filter(c => (debts[c.id]||0) > 0)
    .sort((a,b)=> (debts[b.id]||0) - (debts[a.id]||0));

  // Render panel selección
  renderRouteSelectPanel(debtCustomers, debts);

  // Render tabla
  await renderMapTable(debtCustomers, debts);

  // Mensaje
  const hasKey = !!state.config.mapsKey;
  const canMaps = hasKey && navigator.onLine;
  el("mapNotice").innerHTML = canMaps
    ? `Google Maps activo ✅ · Deudores: <b>${debtCustomers.length}</b> · Selecciona y crea ruta.`
    : `Mapa real desactivado (falta API Key o estás offline). Puedes usar lista y guardar GPS igual.`;

  // Si no se puede, placeholder
  if(!canMaps){
    el("map").innerHTML = `<div class="notice" style="height:100%;display:flex;align-items:center;justify-content:center">
      Sin mapa. Agrega API Key y usa internet para calles/rutas.
    </div>`;
    return;
  }

  await ensureGoogleMaps(state.config.mapsKey);

  // Centro: tu GPS si existe, si no Lorica
  const center = (state.me.lat!=null)
    ? { lat: state.me.lat, lng: state.me.lng }
    : { lat: Number(state.config.centerLat||9.236), lng: Number(state.config.centerLng||-75.814) };

  // Construir mapa una sola vez por refresh
  mapState.map = new google.maps.Map(document.getElementById("map"), {
    center,
    zoom: 14,
    mapTypeControl: false,
    streetViewControl:false,
    fullscreenControl:false
  });
  mapState.info = new google.maps.InfoWindow();

  // services
  mapState.directionsService = new google.maps.DirectionsService();
  mapState.directionsRenderer = new google.maps.DirectionsRenderer({
    map: mapState.map,
    suppressMarkers: false
  });

  // limpiar markers
  mapState.markers.forEach(m=>m.setMap(null));
  mapState.markers = [];

  // marcador de "yo"
  if(state.me.lat!=null){
    mapState.meMarker = new google.maps.Marker({
      map: mapState.map,
      position: { lat: state.me.lat, lng: state.me.lng },
      title: "Mi ubicación"
    });
  }

  // Marcadores de clientes con deuda (solo si tienen GPS)
  for(const c of debtCustomers){
    if(!isNum(c.lat) || !isNum(c.lng)) continue;
    const bal = debts[c.id]||0;

    const m = new google.maps.Marker({
      map: mapState.map,
      position: { lat: c.lat, lng: c.lng },
      title: `${c.name} · $${money(bal)}`
    });
    mapState.markers.push(m);

    m.addListener("click", ()=>{
      const wa = c.phone
        ? `https://wa.me/${digits(c.phone)}?text=${encodeURIComponent(`Hola ${c.name}, soy de BOLLOS_Y_MAZORCAS. Te recuerdo el cobro pendiente de $${money(bal)}. ¿A qué hora puedo pasar?`)}`
        : "";

      mapState.info.setContent(`
        <div style="max-width:260px">
          <b>${escHTML(c.name||"")}</b><br/>
          <span>Saldo: <b>$${money(bal)}</b></span><br/>
          <span>${escHTML(c.addr||"")}</span><br/>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
            ${c.phone ? `<a href="tel:${escHTML(c.phone)}">Llamar</a>` : ""}
            ${wa ? `<a target="_blank" href="${wa}">WhatsApp</a>` : ""}
            <a target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}">Navegar</a>
          </div>
        </div>
      `);
      mapState.info.open(mapState.map, m);
    });
  }
}

function renderRouteSelectPanel(debtCustomers, debts){
  // Mantener selección (si cliente ya no está con deuda, se limpia)
  const validIds = new Set(debtCustomers.map(c=>c.id));
  for(const id of [...mapState.selectedIds]){
    if(!validIds.has(id)) mapState.selectedIds.delete(id);
  }

  const box = el("routeSelectList");
  box.innerHTML = "";

  for(const c of debtCustomers){
    const bal = debts[c.id]||0;
    const hasGPS = isNum(c.lat) && isNum(c.lng);

    const row = document.createElement("div");
    row.className = "checkrow";
    row.innerHTML = `
      <input type="checkbox" data-sel="${c.id}" ${mapState.selectedIds.has(c.id)?"checked":""} ${hasGPS?"":"disabled"}>
      <div style="flex:1">
        <b>${esc(c.name||"")}</b>
        <div class="muted">Saldo: $${money(bal)} · ${hasGPS ? "GPS OK" : "SIN GPS (guarda ubicación)"}</div>
      </div>
      <span class="tag ${hasGPS ? "warn":"bad"}">${hasGPS ? "Ruta" : "GPS"}</span>
    `;
    box.appendChild(row);
  }

  const meta = el("routeSelMeta");
  meta.textContent = `${mapState.selectedIds.size} seleccionados`;

  box.querySelectorAll("input[type=checkbox][data-sel]").forEach(ch=>{
    ch.onchange = ()=>{
      const id = ch.dataset.sel;
      if(ch.checked) mapState.selectedIds.add(id);
      else mapState.selectedIds.delete(id);
      el("routeSelMeta").textContent = `${mapState.selectedIds.size} seleccionados`;
    };
  });
}

async function renderMapTable(debtCustomers, debts){
  await locateMe(false);

  const tb = el("mapCustomerTable");
  tb.innerHTML = "";

  for(const c of debtCustomers){
    const bal = debts[c.id]||0;
    const dist = (state.me.lat!=null && isNum(c.lat) && isNum(c.lng))
      ? (haversine(state.me.lat, state.me.lng, c.lat, c.lng).toFixed(2)+" km")
      : "—";

    const wa = c.phone
      ? `https://wa.me/${digits(c.phone)}?text=${encodeURIComponent(`Hola ${c.name}, soy de BOLLOS_Y_MAZORCAS. Te recuerdo el cobro pendiente de $${money(bal)}. ¿A qué hora puedo pasar?`)}`
      : null;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(c.name||"")}</td>
      <td>$${money(bal)}</td>
      <td>${dist}</td>
      <td>
        ${c.phone ? `<a href="tel:${esc(c.phone)}" class="tag">Llamar</a>` : ""}
        ${wa ? `<a href="${wa}" target="_blank" class="tag good">WhatsApp</a>` : ""}
      </td>
      <td><button class="btn" data-navcust="${c.id}">Navegar</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("button[data-navcust]").forEach(b=>{
    b.onclick = ()=> navigateToCustomer(b.dataset.navcust);
  });
}

async function buildRouteFromSelection(){
  if(!state.config.mapsKey || !navigator.onLine){
    alert("Necesitas internet + API Key para crear ruta real.");
    return;
  }
  if(mapState.selectedIds.size < 2){
    alert("Selecciona mínimo 2 clientes con deuda (y con GPS).");
    return;
  }

  const customers = await DB.all("customers");
  const selected = customers.filter(c => mapState.selectedIds.has(c.id) && isNum(c.lat) && isNum(c.lng));

  if(selected.length < 2){
    alert("Los seleccionados deben tener GPS guardado.");
    return;
  }

  // origen = tu GPS (recomendado). Si no, centro Lorica.
  if(state.me.lat == null) await locateMe(false);

  const origin = (state.me.lat!=null)
    ? { lat: state.me.lat, lng: state.me.lng }
    : { lat: Number(state.config.centerLat||9.236), lng: Number(state.config.centerLng||-75.814) };

  // destination = último, waypoints = resto (Google puede optimizar)
  const destination = { lat: selected[selected.length-1].lat, lng: selected[selected.length-1].lng };
  const waypoints = selected.slice(0, -1).map(c => ({ location: { lat: c.lat, lng: c.lng }, stopover: true }));

  // asegurar mapa cargado
  await ensureGoogleMaps(state.config.mapsKey);
  if(!mapState.map){
    await refreshMap();
  }

  mapState.directionsService.route({
    origin,
    destination,
    waypoints,
    optimizeWaypoints: true,
    travelMode: google.maps.TravelMode.DRIVING
  }, (result, status) => {
    if(status !== "OK" || !result){
      alert("No se pudo calcular ruta: " + status);
      return;
    }
    mapState.directionsRenderer.setDirections(result);

    const route = result.routes[0];
    mapState.lastDirections = result;
    mapState.lastRouteLegs = route.legs;

    let totalDist = 0, totalTime = 0;
    for(const leg of route.legs){
      totalDist += leg.distance?.value || 0;
      totalTime += leg.duration?.value || 0;
    }
    const km = (totalDist/1000).toFixed(2);
    const min = Math.round(totalTime/60);

    el("mapNotice").innerHTML =
      `Ruta creada ✅ Distancia: <b>${km} km</b> · Tiempo: <b>${min} min</b> · Paradas: <b>${route.legs.length}</b> ` +
      `· Puedes guardar la ruta con “💾 Guardar ruta”.`;
  });
}

async function saveBuiltRouteToModule(){
  if(!mapState.lastDirections || !mapState.lastRouteLegs){
    alert("Primero crea una ruta (🧭 Crear ruta).");
    return;
  }

  // Guardar como ruta en módulo "Rutas"
  const date = todayISO();
  const routeId = DB.id();

  // Calcular totales
  let totalDist = 0, totalTime = 0;
  for(const leg of mapState.lastRouteLegs){
    totalDist += leg.distance?.value || 0;
    totalTime += leg.duration?.value || 0;
  }
  const km = +(totalDist/1000).toFixed(2);
  const minutes = Math.round(totalTime/60);

  const route = {
    id: routeId,
    name: `Ruta Cobro (Mapa) ${new Date().toLocaleDateString("es-CO")}`,
    date,
    createdAt: now(),
    createdBy: state.session.userId,
    status: "activa",
    source: "map",
    km,
    minutes
  };
  await DB.put("routes", route);

  // Orden final de paradas:
  // waypoint_order te devuelve el orden de los waypoints; nosotros también añadimos destino final como última parada.
  const customers = await DB.all("customers");
  const selected = customers.filter(c => mapState.selectedIds.has(c.id) && isNum(c.lat) && isNum(c.lng));

  // Construimos una lista en el mismo orden en que se enviaron:
  // waypoints = selected.slice(0,-1); destination = selected[last]
  const waypointsSent = selected.slice(0, -1);
  const destinationSent = selected[selected.length-1];

  const wpOrder = mapState.lastDirections.routes[0].waypoint_order || [];
  const orderedStops = wpOrder.map(i => waypointsSent[i]);
  orderedStops.push(destinationSent); // el destino al final

  let order = 1;
  for(const c of orderedStops){
    await DB.put("route_stops", {
      id: DB.id(),
      routeId,
      order: order++,
      customerId: c.id,
      state: "Pendiente",
      updatedAt: now()
    });
  }

  await DB.queue("upsert_route", { route });
  alert("Ruta guardada en el módulo Rutas ✅");
  go("routes");
}

async function startLiveTracking(){
  if(!navigator.onLine){
    alert("Para ruta en tiempo real necesitas internet.");
    return;
  }
  if(!state.config.mapsKey){
    alert("Pon tu API Key en Configuración.");
    return;
  }

  await ensureGoogleMaps(state.config.mapsKey);

  // mapa base (si no existe, crear)
  const center = (state.me.lat!=null)
    ? { lat: state.me.lat, lng: state.me.lng }
    : { lat: Number(state.config.centerLat||9.236), lng: Number(state.config.centerLng||-75.814) };

  mapState.map = new google.maps.Map(document.getElementById("map"), {
    center,
    zoom: 16,
    mapTypeControl:false,
    streetViewControl:false,
    fullscreenControl:false
  });

  mapState.livePath = [];
  mapState.livePolyline = new google.maps.Polyline({
    map: mapState.map,
    path: mapState.livePath,
    geodesic: true
  });

  mapState.liveMarker = new google.maps.Marker({
    map: mapState.map,
    position: center,
    title: "Mi ubicación (Live)"
  });

  if(mapState.liveWatchId != null){
    navigator.geolocation.clearWatch(mapState.liveWatchId);
    mapState.liveWatchId = null;
  }

  mapState.liveWatchId = navigator.geolocation.watchPosition(
    async (p) => {
      const lat = p.coords.latitude;
      const lng = p.coords.longitude;

      state.me = { lat, lng };
      const pos = { lat, lng };

      mapState.liveMarker.setPosition(pos);
      mapState.map.setCenter(pos);

      mapState.livePath.push(pos);
      mapState.livePolyline.setPath(mapState.livePath);

      // guardar puntos opcional
      if(Number(state.config.trackSave||1) === 1){
        await DB.put("tracks", { id: DB.id(), at: Date.now(), lat, lng, userId: state.session.userId });
      }

      el("mapNotice").innerHTML =
        `🛰️ Live activo · GPS: <b>${lat.toFixed(5)}, ${lng.toFixed(5)}</b> · Puntos: <b>${mapState.livePath.length}</b>`;
    },
    (err) => alert("Error GPS (live): " + err.message),
    { enableHighAccuracy:true, maximumAge:2000, timeout:10000 }
  );
}

function stopLiveTracking(){
  if(mapState.liveWatchId != null){
    navigator.geolocation.clearWatch(mapState.liveWatchId);
    mapState.liveWatchId = null;
  }
  el("mapNotice").innerHTML = "Tracking detenido.";
}

async function ensureGoogleMaps(key){
  if(window.google?.maps) return true;
  await new Promise((resolve, reject)=>{
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return true;
}

async function locateMe(showAlert=true){
  try{
    const pos = await getGPS();
    state.me = pos;
    if(showAlert) alert("Ubicación actual actualizada.");
  }catch(e){
    if(showAlert) alert("No se pudo obtener GPS. Revisa permisos.");
  }
}

function getGPS(){
  return new Promise((resolve, reject)=>{
    if(!navigator.geolocation) return reject(new Error("no geo"));
    navigator.geolocation.getCurrentPosition(
      (p)=> resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (err)=> reject(err),
      { enableHighAccuracy:true, timeout:10000, maximumAge:20000 }
    );
  });
}

function navigateToCustomer(customerId){
  DB.get("customers", customerId).then(c=>{
    if(!c) return;
    if(isNum(c.lat) && isNum(c.lng)){
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`, "_blank");
    }else{
      alert("Este cliente no tiene GPS guardado. En Clientes: 'Guardar ubicación aquí'.");
    }
  });
}

// ---------------- DEBTS ----------------
async function computeCustomerDebts(){
  const sales = await DB.all("sales");
  const payments = await DB.all("payments");

  const credit = {};
  for(const s of sales){
    if(s.type==="credit"){
      credit[s.customerId] = (credit[s.customerId]||0) + Number(s.total||0);
    }
  }
  for(const p of payments){
    credit[p.customerId] = (credit[p.customerId]||0) - Number(p.amount||0);
  }
  return credit;
}

// ---------------- USERS (ADMIN) ----------------
let editingUserId = null;

async function renderUsers(){
  requireAdmin();
  const users = (await DB.all("users"))
    .filter(u => u.id !== "admin-fixed")
    .sort((a,b)=>(a.name||"").localeCompare(b.name||""));

  const tb = el("userTable");
  tb.innerHTML = "";

  for(const u of users){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(u.name||"")}</td>
      <td>${esc(u.email||"")}</td>
      <td>${u.active?'<span class="tag good">Activo</span>':'<span class="tag bad">Inactivo</span>'}</td>
      <td><button class="btn" data-edit-user="${u.id}">Editar</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("button[data-edit-user]").forEach(b=>{
    b.onclick = ()=> openUserForm(b.dataset.editUser);
  });

  openUserForm(null, true);
}

async function openUserForm(userId, forceClose=false){
  const form = el("userForm");
  if(forceClose){
    form.classList.add("hidden");
    editingUserId = null;
    return;
  }
  form.classList.remove("hidden");
  el("btnDeleteUser").classList.toggle("hidden", !userId);

  if(!userId){
    editingUserId = null;
    el("uName").value="";
    el("uEmail").value="";
    el("uPass").value="";
    el("uActive").value="1";
    return;
  }

  const u = await DB.get("users", userId);
  if(!u) return;
  editingUserId = u.id;
  el("uName").value=u.name||"";
  el("uEmail").value=u.email||"";
  el("uPass").value=u.pass||"";
  el("uActive").value=u.active ? "1":"0";
}

async function saveUser(){
  requireAdmin();
  const name = el("uName").value.trim();
  const email = el("uEmail").value.trim().toLowerCase();
  const pass = el("uPass").value.trim();
  const active = el("uActive").value==="1"?1:0;

  if(!name || !email || !pass){ alert("Completa nombre, email y contraseña."); return; }
  if(email==="admin@bollos.com"){ alert("Ese email es del admin fijo."); return; }

  const all = await DB.all("users");
  const exists = all.find(u=>u.email.toLowerCase()===email && u.id!==editingUserId);
  if(exists){ alert("Ese email ya existe."); return; }

  if(editingUserId){
    const u = await DB.get("users", editingUserId);
    const updated = { ...u, name, email, pass, active, updatedAt: now() };
    await DB.put("users", updated);
    await DB.queue("upsert_user", updated);
  }else{
    const u = { id: DB.id(), role:"seller", name, email, pass, active, createdAt: now(), updatedAt: now() };
    await DB.put("users", u);
    await DB.queue("upsert_user", u);
  }

  await renderUsers();
}

async function deleteUser(){
  requireAdmin();
  if(!editingUserId) return;
  if(!confirm("¿Eliminar vendedor?")) return;
  await DB.del("users", editingUserId);
  await DB.queue("delete_user", { id: editingUserId });
  editingUserId = null;
  await renderUsers();
}

// ---------------- CSV EXPORT ----------------
async function exportCSVBundle(){
  const bundles = {
    products: await DB.all("products"),
    customers: await DB.all("customers"),
    sales: await DB.all("sales"),
    sale_items: await DB.all("sale_items"),
    payments: await DB.all("payments"),
    routes: await DB.all("routes"),
    route_stops: await DB.all("route_stops"),
    tracks: await DB.all("tracks"),
    expenses: await DB.all("expenses"),
  };

  let out = "";
  for(const [name, arr] of Object.entries(bundles)){
    out += `### ${name}.csv\n${toCSV(arr)}\n\n`;
  }
  downloadText(out, `bollos_export_${todayISO()}.txt`);
}

function toCSV(arr){
  if(!arr || arr.length===0) return "";
  const cols = Object.keys(arr[0]);
  const lines = [cols.join(",")];
  for(const row of arr){
    lines.push(cols.map(c=>csvCell(row[c])).join(","));
  }
  return lines.join("\n");
}
function csvCell(v){
  const s = (v===null||v===undefined) ? "" : String(v);
  const escaped = s.replaceAll('"','""');
  return `"${escaped}"`;
}
function downloadText(text, filename){
  const blob = new Blob([text], {type:"text/plain;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- SYNC placeholder ----------------
async function syncNow(){
  const mode = state.config.syncMode || "local";
  if(mode==="local"){
    alert("Sync: Solo local. Si quieres sync real multi-dispositivo, se activa con Supabase.");
    return;
  }
  alert("Supabase no está conectado en este template (pero ya tienes outbox listo).");
}

// ---------------- HELPERS ----------------
function esc(s){ return String(s||"").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
function escHTML(s){ return esc(s); }
function digits(s){ return String(s||"").replace(/\D+/g,""); }
function isNum(n){ return typeof n==="number" && !Number.isNaN(n); }

function haversine(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a =
    Math.sin(dLat/2)*Math.sin(dLat/2) +
    Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180) *
    Math.sin(dLon/2)*Math.sin(dLon/2);
  return 2*R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function registerSW(){
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }
}
