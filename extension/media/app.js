/* Local-only webview: all remote/user data is rendered as text, never HTML. */
const vscode = acquireVsCodeApi();
let sequence = 0,
  state = {},
  view = "operations",
  selected,
  catalogRevision,
  previousRender = "",
  refreshing = false,
  renderVersion = 0;
const pending = new Map(),
  content = document.getElementById("content"),
  notice = document.getElementById("notice");
const names = {
  connections: "Conexiones",
  operations: "Operaciones",
  catalog: "Catálogo YAML",
  explore: "Explorar Azure",
  history: "Ejecuciones",
  integration: "Copilot y MCP",
};
function element(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function notify(text, error = false) {
  notice.textContent = text;
  notice.className = error ? "error" : "notice";
}
function api(action, data) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    vscode.postMessage({ id, action, data, profileId: state.active });
  });
}
function button(text, action, primary = false) {
  const b = element("button", text, primary ? "primary" : "");
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await action();
    } catch (e) {
      notify(e.message, true);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function code(value) {
  return element(
    "pre",
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}
function field(label, control) {
  const wrap = element("label", label);
  wrap.append(control);
  return wrap;
}
function input(type = "text", value = "") {
  const e = document.createElement("input");
  e.type = type;
  e.value = value;
  return e;
}
function select(options) {
  const e = document.createElement("select");
  for (const [value, label] of options) {
    const o = element("option", label);
    o.value = value;
    e.append(o);
  }
  return e;
}
function actions(...buttons) {
  const row = element("div", undefined, "actions");
  row.append(...buttons);
  return row;
}
function navigate(next, id) {
  if (
    view === "catalog" &&
    document.querySelector("textarea")?.dataset.dirty === "true"
  ) {
    if (!confirm("Hay cambios sin guardar. ¿Salir del editor?")) return;
  }
  view = next;
  selected = id;
  previousRender = "";
  render();
}
for (const [key, label] of Object.entries(names))
  document.getElementById("tabs").append(button(label, () => navigate(key)));
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api("snapshot");
    document.getElementById("connection").textContent =
      state.profiles?.find((p) => p.id === state.active)?.name ??
      "Sin conexión";
    if (view === "history" || view === "operations" || view === "connections") {
      const stamp = JSON.stringify({ view, state, selected });
      if (stamp !== previousRender) {
        previousRender = stamp;
        await render();
      } else if (view === "history" && selected) await showExecution();
    }
  } catch (e) {
    notify(e.message, true);
  } finally {
    refreshing = false;
  }
}
async function render() {
  const currentRender = ++renderVersion;
  content.replaceChildren();
  document
    .querySelectorAll("nav button")
    .forEach((b) =>
      b.setAttribute("aria-current", String(b.textContent === names[view])),
    );
  if (!state.trusted) {
    content.append(
      element("h2", "Confía en el workspace para continuar"),
      element(
        "p",
        "Las conexiones y operaciones permanecen deshabilitadas en modo restringido.",
      ),
    );
    return;
  }
  if (view === "connections") {
    content.append(
      element("h2", "Conexiones privadas"),
      element(
        "p",
        "Tokens en SecretStorage; nunca se guardan en el repositorio ni se envían al chat.",
      ),
      button(
        "Agregar conexión",
        async () => {
          await api("addProfile");
          await refresh();
        },
        true,
      ),
    );
    for (const p of state.profiles ?? []) {
      const card = element("section", undefined, "card");
      card.append(
        element("h3", p.name),
        element("p", p.organization + " / " + p.project),
        actions(
          button(
            state.active === p.id ? "Conectado · reconectar" : "Conectar",
            async () => {
              await api("connect", p.id);
              await refresh();
            },
          ),
          button("Cambiar token", () => api("rotate", p.id)),
          button("Certificado / proxy", () => api("network", p.id)),
          button("Renombrar", () => api("editProfile", p.id)),
          button("Importar historial CLI", async () => {
            const r = await api("importHistory", p.id);
            if (r) notify(r.message);
          }),
          button("Olvidar token", async () => {
            await api("remove", p.id);
            await refresh();
          }),
        ),
      );
      content.append(card);
    }
    if (state.active)
      content.append(
        actions(
          button("Probar conexión", async () => {
            const r = await api("testConnection");
            notify(r.message);
          }),
          button("Desconectar", async () => {
            await api("stop");
            await refresh();
          }),
        ),
      );
    return;
  }
  if (view === "integration") {
    content.append(
      element("h2", "Copilot es tu punto de entrada"),
      element(
        "p",
        "En Copilot abre el selector de herramientas y habilita Azure DevOps Classic Workbench. Autoriza el servidor cuando VS Code lo solicite. Conecta primero un perfil para que aparezcan las herramientas de Azure.",
      ),
      code(
        "Lista mis operaciones y prepara la operación elegida. Abre su revisión en Workbench; no uses terminal para aplicar cambios.",
      ),
      element(
        "p",
        "El panel confirma las escrituras. El chat puede consultar la misma ejecución. Si antes configuraste el servidor stdio manualmente, detenlo para evitar coordinadores duplicados.",
      ),
      button("Configuración para otro cliente MCP", async () => {
        const result = await api("integration");
        notify(result.message);
      }),
      element(
        "p",
        "Otros clientes necesitan Streamable HTTP y soporte de headers. El enlace y la credencial de sesión caducan al cerrar VS Code. No es un PAT.",
      ),
    );
    return;
  }
  if (!state.active) {
    content.append(
      element("h2", "Conecta Azure DevOps"),
      element(
        "p",
        "Puedes configurar una conexión sin instalar Node ni abrir la terminal.",
      ),
      button("Ir a conexiones", () => navigate("connections"), true),
    );
    return;
  }
  if (view === "operations") {
    content.append(
      element("h2", "Operaciones recurrentes"),
      element(
        "p",
        "Prepara un plan fijado a un release y revisa el diff antes de continuar.",
      ),
      actions(
        button(
          state.capabilities?.writesEnabled
            ? "Deshabilitar escrituras"
            : "Habilitar escrituras revisadas",
          () => api("permissions", "writes"),
        ),
        button(
          state.capabilities?.approvalsEnabled
            ? "Deshabilitar decisiones de aprobación"
            : "Habilitar decisiones de aprobación",
          () => api("permissions", "approvals"),
        ),
        button("Crear operación", async () => {
          await api("wizard");
          navigate("catalog");
        }),
      ),
    );
    if (!state.operations?.length)
      content.append(
        element(
          "p",
          "No hay operaciones. Importa tu YAML actual o usa el asistente.",
        ),
        button("Abrir catálogo", () => navigate("catalog")),
      );
    for (const op of state.operations ?? []) {
      const card = element("section", undefined, "card"),
        mode = select(op.modes.map((m) => [m, m]));
      card.append(
        element("h3", op.id),
        element("p", op.description),
        field("Modo", mode),
        button(
          "Preparar y revisar",
          async () => {
            const r = await api("plan", { operation: op.id, mode: mode.value });
            navigate("history", r.id);
          },
          true,
        ),
      );
      content.append(card);
    }
    return;
  }
  if (view === "catalog") {
    const c = await api("catalog");
    if (currentRender !== renderVersion) return;
    catalogRevision = c.draft?.revision ?? c.revision;
    const editor = document.createElement("textarea");
    editor.value = c.draft?.text ?? c.text;
    editor.spellcheck = false;
    editor.setAttribute("aria-label", "Catálogo YAML");
    editor.addEventListener("input", () => (editor.dataset.dirty = "true"));
    content.append(
      element(
        "h2",
        c.draft ? "Revisar borrador de catálogo" : "Catálogo de operaciones",
      ),
      element(
        "p",
        "Fuente de verdad compartida por Copilot y panel. Solo valores no secretos. Guardar invalida planes que usen el catálogo anterior.",
      ),
    );
    const old = element("details");
    old.append(
      element("summary", "Ver versión guardada para comparar"),
      code(c.text),
    );
    content.append(
      old,
      editor,
      actions(
        button("Validar", async () => {
          await api("validate", editor.value);
          notify("Catálogo válido. No se guardó ni se modificó Azure.");
        }),
        button(
          "Guardar catálogo revisado",
          async () => {
            await api("save", {
              text: editor.value,
              revision: catalogRevision,
            });
            editor.dataset.dirty = "false";
            notify("Catálogo guardado. No se modificó Azure.");
            await render();
          },
          true,
        ),
        button("Asistente de nueva operación", async () => {
          await api("wizard");
          await render();
        }),
        button("Importar YAML", async () => {
          await api("import");
          await render();
        }),
        button("Exportar YAML guardado", () => api("export")),
        button("Descartar borrador / recargar", async () => {
          if (
            editor.dataset.dirty !== "true" ||
            confirm("¿Descartar la edición local y recargar?")
          ) {
            await api("discardDraft");
            await render();
          }
        }),
      ),
    );
    return;
  }
  if (view === "history") {
    content.append(element("h2", "Ejecuciones y revisión"));
    const choices = select([
      ["", "Selecciona una ejecución"],
      ...(state.executions ?? []).map((r) => [
        r.id,
        `${r.releaseName} · ${r.operation} · ${r.state}`,
      ]),
    ]);
    choices.value = selected ?? "";
    choices.addEventListener("change", () => {
      selected = choices.value;
      showExecution();
    });
    content.append(choices, element("div", undefined, "execution"));
    await showExecution();
    return;
  }
  if (view === "explore") {
    content.append(
      element("h2", "Explorar Azure"),
      element(
        "p",
        "Consultas de lectura sobre la conexión activa. Los secretos siempre se ocultan.",
      ),
    );
    const kind = select([
        ["organizations", "Organizaciones configuradas"],
        ["discoverOrganizations", "Descubrir organizaciones por memberId"],
        ["projects", "Proyectos"],
        ["definitions", "Definiciones"],
        ["definition", "Detalle de definición"],
        ["environments", "Stages de definición"],
        ["variables", "Variables de definición"],
        ["releases", "Releases"],
        ["release", "Detalle de release"],
        ["latest", "Último release"],
      ]),
      def = input("number"),
      rel = input("number"),
      env = input("number"),
      member = input(),
      search = input(),
      token = input(),
      envName = input(),
      strategy = select([
        ["latestCreated", "Último creado"],
        ["latestSuccessfulDeployment", "Último despliegue exitoso"],
      ]),
      visible = input("checkbox");
    content.append(
      field("Consulta", kind),
      field("Definition ID (cuando corresponda)", def),
      field("Release ID (detalle de release)", rel),
      field("Environment ID (variables de definición, opcional)", env),
      field("Nombre del environment (último despliegue exitoso)", envName),
      field("Selección de último release", strategy),
      field("Member UUID (descubrir organizaciones)", member),
      field("Buscar definición", search),
      field("Continuation token (página siguiente)", token),
      field("Mostrar valores visibles no secretos", visible),
    );
    const result = code("");
    content.append(
      button(
        "Consultar",
        async () => {
          const q = { kind: kind.value, includeValues: visible.checked };
          if (def.value) q.definitionId = Number(def.value);
          if (rel.value) q.releaseId = Number(rel.value);
          if (env.value) q.environmentId = Number(env.value);
          if (member.value) q.memberId = member.value;
          if (search.value) q.searchText = search.value;
          if (token.value) q.continuationToken = token.value;
          if (kind.value === "latest") {
            q.strategy = strategy.value;
            if (envName.value) q.environmentName = envName.value;
          }
          result.textContent = JSON.stringify(await api("explore", q), null, 2);
        },
        true,
      ),
      result,
    );
  }
}
async function showExecution() {
  const area = document.querySelector(".execution");
  if (!area || !selected) return;
  const requested = selected;
  const r = await api("execution", requested);
  if (view !== "history" || requested !== selected || !area.isConnected) return;
  const serialized = JSON.stringify(r);
  if (area.dataset.current === serialized) return;
  area.dataset.current = serialized;
  area.replaceChildren();
  area.append(
    element("h3", r.releaseName + " · " + r.environmentName),
    element(
      "p",
      `${r.target.organization} / ${r.target.project} · Release ${r.releaseId} · Stage ${r.environmentId}`,
    ),
    element("p", "Estado: " + r.state, "badge"),
  );
  if (r.observedAttempt !== undefined)
    area.append(element("p", "Intento observado: " + r.observedAttempt));
  area.append(element("h4", "Cambios revisados"));
  const table = element("table"),
    head = element("tr");
  for (const x of ["Variable", "Scope", "Antes", "Después"])
    head.append(element("th", x));
  table.append(head);
  for (const d of r.changes) {
    const tr = element("tr");
    for (const x of [
      d.name,
      d.scope,
      d.before?.value ?? "(ausente)",
      d.after?.value ?? "(eliminar)",
    ])
      tr.append(element("td", String(x)));
    table.append(tr);
  }
  area.append(table, element("h4", "Artefactos fijados"), code(r.artifacts));
  for (const w of r.warnings ?? [])
    area.append(element("p", w.message, "warning"));
  const act = async (action, args) => {
    const out = await api("executionAction", {
      action,
      executionId: r.id,
      args,
    });
    if (out?.id) selected = out.id;
    await refresh();
    await showExecution();
  };
  if (r.state === "planned") {
    const apply = button(
      "Continuar · aplicar y redesplegar",
      () => act("apply"),
      true,
    );
    apply.disabled = !state.capabilities?.writesEnabled;
    area.append(
      actions(
        apply,
        button("Cancelar plan", () => act("cancel")),
      ),
    );
    if (!state.capabilities?.writesEnabled)
      area.append(
        element(
          "p",
          "Habilita escrituras revisadas en Operaciones para continuar.",
        ),
      );
  }
  if (["succeeded", "failed"].includes(r.state))
    area.append(button("Preparar restauración", () => act("rollback")));
  if (["uncertain", "interrupted", "trackingTimedOut"].includes(r.state))
    area.append(
      element(
        "p",
        "Revisa en Azure las variables y el intento. Reconciliar libera el bloqueo local, sin reenviar ni revertir escrituras.",
        "warning",
      ),
      button("He reconciliado el estado en Azure", () => act("recover")),
    );
  for (const a of r.approvals ?? []) {
    area.append(element("p", `Aprobación ${a.id}: ${a.approver}`));
    if (
      r.policy.approvals === "explicit" &&
      state.capabilities?.approvalsEnabled &&
      r.state === "awaitingApproval"
    )
      area.append(
        actions(
          button("Aprobar", () =>
            act("approval", { approvalId: a.id, decision: "approved" }),
          ),
          button("Rechazar", () =>
            act("approval", { approvalId: a.id, decision: "rejected" }),
          ),
        ),
      );
  }
  if (r.error)
    area.append(element("p", r.error.code + ": " + r.error.message, "error"));
  if (r.observabilityError)
    area.append(
      element(
        "p",
        "Visibilidad de aprobaciones limitada: " + r.observabilityError.code,
        "warning",
      ),
    );
  area.append(element("h4", "Historial"));
  for (const e of r.events)
    area.append(
      element(
        "p",
        new Date(e.at).toLocaleString() + " · " + e.message,
        "event",
      ),
    );
}
window.addEventListener("message", async ({ data }) => {
  if (data.id !== undefined) {
    const item = pending.get(data.id);
    if (item) {
      pending.delete(data.id);
      if (data.error) item.reject(new Error(data.error));
      else item.resolve(data.result);
    }
  } else if (data.event === "navigate") {
    try {
      state = await api("snapshot");
      navigate(data.view, data.executionId);
    } catch (e) {
      notify(e.message, true);
    }
  } else if (data.event === "refresh") refresh();
});
api("ready")
  .then((s) => {
    state = s;
    render();
  })
  .catch((e) => notify(e.message, true));
setInterval(() => refresh(), 5000);
