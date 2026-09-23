# Prueba supervisada en Windows

Esta guía usa únicamente nombres sintéticos. Sustituye los selectores en tu archivo local por los de una definición de prueba. No compartas `.env`, catálogos locales, enlaces de sesión ni el directorio de estado.

## 1. Compilar y comprobar

Detén el servidor MCP en Copilot y cierra cualquier Inspector que use el mismo directorio de estado. Abre PowerShell en la carpeta del proyecto, con Node 22.13+ de la rama 22 o Node 24+ disponible:

```powershell
node --version
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run format:check
npm.cmd run check
```

Si usas Node portable, añade **tu carpeta que contiene node.exe** al PATH de esa sesión antes de ejecutar. La configuración TLS corporativa debe estar resuelta antes de arrancar Node; conserva la CA confiable configurada y no deshabilites la validación TLS.

## 2. Catálogo local

No sobrescribas un catálogo existente. Si aún no tienes uno:

```powershell
if (!(Test-Path operations.local.yaml)) {
    Copy-Item examples/operations.ids.yaml operations.local.yaml
}
notepad operations.local.yaml
```

Conserva la operación genérica `integration-mode` y configura en el archivo local:

- Tu organización/proyecto, definitionId, definitionEnvironmentId y expectedName exactos. El ID del environment de una **definición** no es el ID de su instancia en un release: el motor resuelve este último.
- `selection.strategy: latestCreated`, sin `releaseId`. Para una prueba con release fijado puedes usar `strategy: explicit` y `releaseId`.
- Los nombres y scopes exactos de las variables de prueba, con valores string para `simulated` y `live`. Elimina la segunda variable de ejemplo si no la necesitas.
- `deployment.strategy: environmentRedeploy` y `redeployWhenUnchanged: true`.
- `downstreamPolicy: reject` inicialmente. Solo usa `allow` si aceptas los posibles stages posteriores mostrados en la revisión.
- `approvals: external`.

```powershell
npm.cmd run catalog:validate -- operations.local.yaml
notepad .env
```

Mantén tu credencial únicamente en `.env`. Usa rutas absolutas propias en `AZDO_OPERATIONS_FILE` y `AZDO_STATE_DIR`. Configura `AZDO_ENABLE_WRITES=false` y `AZDO_ENABLE_APPROVALS=false` para la primera revisión. No cambies el directorio de estado para evadir un lock o una ejecución incierta.

## 3. Iniciar Inspector y revisar sin escribir

```powershell
npx.cmd -y @modelcontextprotocol/inspector node --env-file=.env dist/index.js
```

Abre la URL local que imprime Inspector, conecta el servidor y entra a **Tools**. Ejecuta `ado_list_operations`. Después selecciona **ado_plan_operation**, activa **Edit as JSON** y usa:

```json
{
  "operation": "integration-mode",
  "mode": "simulated"
}
```

Abre el enlace de revisión devuelto. Verifica release, instancia del stage, artefacto/versión, variables y scopes, valores anteriores/nuevos y advertencias. Con escrituras deshabilitadas el panel no permite aplicar. Planificar no modifica Azure.

## 4. Ejecutar la prueba

Tras revisar los permisos mínimos y el objetivo de prueba, detén Inspector con Ctrl+C. Cambia **solo** `AZDO_ENABLE_WRITES=true` en `.env`, reinicia con el mismo comando y prepara **un plan nuevo**. Mantén aprobaciones deshabilitadas en el MCP; si Azure las requiere, resuélvelas en su interfaz.

Aplica desde la revisión local. El historial esperado distingue:

```text
Local review accepted; saving variables.
Variable update request accepted.
Variables saved and verified.
Post-update validation passed.
Requesting environment redeploy.
Deployment request accepted; waiting for this deployment attempt.
Deployment attempt detected: N.
Deployment state: succeeded
```

Si los valores ya coinciden, aparecerá el evento de redeploy sin cambios y **no habrá PUT**. Un PATCH aceptado puede tardar en mostrar un intento nuevo; el éxito anterior no termina esta operación. Consulta `ado_get_operation_status` con el ID devuelto por el plan o utiliza el panel.

Comprueba también en Azure que se utilizó el release revisado, que apareció el intento nuevo del stage correcto y que el resultado coincide. Con downstream `allow`, comprueba qué otros stages se activaron; el MCP no promete aislamiento de esos efectos.

## 5. Restaurar o reconciliar

Para probar restauración después de un resultado terminal, ejecuta `ado_plan_operation_rollback`:

```json
{
  "id": "REEMPLAZAR_POR_UUID_DE_LA_EJECUCION_ORIGINAL"
}
```

Revisa el nuevo diff antes de aplicar. Debe recuperar el valor anterior exacto; una variable creada por la operación debe eliminarse. La restauración realiza su propio redeploy revisado.

Ante `uncertain`, `interrupted` o `trackingTimedOut`, **no vuelvas a enviar la escritura**. Revisa en Azure si se guardaron las variables, si existe el intento solicitado, si quedan aprobaciones y si hay actividad en curso. Solo después de reconciliar pulsa «He reconciliado el estado en Azure». Esto conserva el historial y libera el bloqueo local; no revierte ni cancela nada. Después prepara otro plan, nunca reutilices el incierto.

`STORE_LOCKED` requiere comprobar que no hay otro coordinador usando el estado. No borres registros cifrados ni la clave. Otros códigos de arranque: `INVALID_CONFIGURATION`, `INVALID_CATALOG`, `REVIEW_SERVER_FAILED`, `STATE_UNAVAILABLE`.

Al terminar, detén Inspector, vuelve a `AZDO_ENABLE_WRITES=false` y luego inicia el MCP en Copilot si lo necesitas. Usa un solo coordinador para el mismo estado.
