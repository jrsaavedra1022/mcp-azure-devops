# Operaciones recurrentes (0.2, preview)

El servidor ofrece diez tools de lectura, incluidas las siete originales. Con `AZDO_OPERATIONS_FILE` habilita seis tools adicionales de catálogo, planificación, historial y panel. Solo la interfaz local puede aplicar planes: no existe una tool MCP que escriba directamente o apruebe un plan. Esta separación evita llamadas accidentales desde el modelo; no constituye aislamiento frente a software malicioso con acceso al mismo usuario y al enlace de sesión.

## Probar sin Azure

```sh
npm ci
npm run check
npm run demo
```

Abre la URL completa impresa. El ejemplo utiliza datos sintéticos y un adapter en memoria: revisar, aplicar, actualizar el progreso y preparar restauración funciona sin PAT. La demo completa el despliegue simulado inmediatamente; nunca ejecuta solicitudes Azure. El historial cifrado de esta demo se crea en el directorio temporal del sistema.

## Configurar una organización real

1. Copia `examples/operations.yaml` a `operations.local.yaml` (ignorado por Git).
2. Ajusta organización, proyecto, definitionId y definitionEnvironmentId. `expectedName` debe coincidir exactamente con el stage.
3. Define los nombres exactos y ámbitos de variables, y los modos permitidos con valores de tipo string.
4. Valida con `npm run catalog:validate -- operations.local.yaml`.
5. Configura `.env` con la credencial personal y:

```dotenv
AZDO_OPERATIONS_FILE=C:/absolute/path/mcp-azure-devops/operations.local.yaml
AZDO_STATE_DIR=C:/Users/YOUR_USER/AppData/Local/azure-devops-classic-mcp/state
AZDO_ENABLE_WRITES=false
AZDO_ENABLE_APPROVALS=false
```

En macOS/Linux usa rutas absolutas del sistema. Sin `AZDO_STATE_DIR`, el estado se ubica en `.azure-devops-classic-mcp/state` dentro del perfil del usuario. Todos los procesos de producción del mismo usuario deben usar el mismo directorio; un segundo coordinador será rechazado. No uses distintos directorios para sortear el bloqueo.

Con escrituras deshabilitadas puedes planificar y revisar. Antes de habilitar `AZDO_ENABLE_WRITES=true`, valida en una definición de prueba sin impacto, con un solo operador y los permisos mínimos. Reinicia el servidor al cambiar las variables de entorno. Cambiar YAML invalida planes anteriores automáticamente.

## Uso con Copilot

El repositorio incluye `.vscode/mcp.json`. Abre la carpeta raíz en VS Code y compila con `npm run build` antes de iniciar el servidor. La configuración compartida no contiene PAT:

```json
{
  "servers": {
    "azure-devops-classic": {
      "type": "stdio",
      "command": "node",
      "cwd": "${workspaceFolder}",
      "args": [
        "--env-file=${workspaceFolder}/.env",
        "${workspaceFolder}/dist/index.js"
      ]
    }
  }
}
```

Ejemplo: «Lista las operaciones y prepara integration-mode con modo simulated. Muéstrame el enlace de revisión; no intentes ejecutar el cambio por otros medios».

- `ado_list_operations`: catálogo y modos disponibles.
- `ado_plan_operation`: `{ "operation": "integration-mode", "mode": "simulated" }`.
- `ado_get_operation_status`: `{ "id": "UUID" }`.
- `ado_list_operation_executions`: historial local.
- `ado_open_operation_review`: enlace vigente, opcionalmente para un ID.
- `ado_plan_operation_rollback`: prepara restauración para un ID original; aún exige revisión local.

Las tools no devuelven valores de variables. El panel local sí muestra los valores no secretos del diff. El enlace contiene una capacidad de sesión en su fragmento; no se envía en los logs HTTP ni como Referer y debe tratarse como privado. Copilot recibe ese enlace y técnicamente otros procesos del mismo usuario pueden usarlo: esta revisión es una protección contra ejecución accidental, no prueba criptográfica de presencia humana.

Inspector: `npx -y @modelcontextprotocol/inspector node --env-file=.env dist/index.js`. En Windows puede usarse `npx.cmd`. No ejecutes simultáneamente Inspector y Copilot contra el mismo estado. La demo sí es independiente y nunca accede a Azure.

## Contrato YAML

`schemaVersion` debe ser la cadena `"1"`. Todos los objetos de configuración rechazan propiedades desconocidas, claves YAML duplicadas y aliases. No hay interpolación, scripts, URLs de API arbitrarias ni expresiones ejecutables. Máximo: 256 KiB de catálogo, 50 variables por operación y 20 modos. Los valores son strings; usa `"true"` y `"false"`.

Cada target especifica organización/proyecto, definición, stage de definición y nombre esperado. Cada operación referencia un target, lista modos y contiene el mapa completo de valores por variable. Una identidad de variable es su ámbito (`release` o `environment`) más nombre exacto. Diferencias de mayúsculas ambiguas fallan. `mustExist: false` permite agregar una variable no existente. La restauración puede eliminar únicamente la variable creada por esa operación, si su estado sigue coincidiendo.

Selección:

- `latestCreated`: último release activo por fecha de creación.
- `latestSuccessfulDeployment`: busca el historial de despliegues exitosos del environment y elige un release activo. Examina hasta 20 páginas de 50 despliegues y falla si no puede resolverlo; no hace fallback a «último creado».
- `explicit`: requiere `releaseId` y no acepta ese campo en otras estrategias.
- `sourceBranch`: filtro opcional `refs/heads/...`; no se infiere Git Flow o trunk-based de nombres.

Se fija el release seleccionado y el environment de su instancia en el plan. Crear otro release no cambia el objetivo ni el rollback. La demo ilustra la resolución. No se crean releases ni se cambian las versiones de sus artefactos.

## Ejecución y protección de secretos

Planificar lee Azure y guarda un diff no secreto y una huella de la instantánea. Al aplicar se verifica caducidad, catálogo, estado y huella. Se obtiene la instancia completa, se cambian solo las entradas seleccionadas y se envía por el endpoint oficial PUT de release. El resto del objeto se conserva, incluidos campos no modelados. Se lee nuevamente para comprobar los valores y detectar alteraciones inesperadas antes del PATCH de redeploy.

Solo pueden modificarse variables cuyo `isSecret` sea explícitamente `false` y cuyo valor sea string. Si Azure omite ese indicador, la operación falla hasta revisar el caso; no se asume que es seguro. Los secretos existentes fuera del diff se conservan en la solicitud tal como Azure los devuelve; no se convierten en strings ni se incluyen en el registro. El comportamiento de preservación de secretos y grupos con la API de tu organización debe comprobarse en la prueba de integración antes de uso real. No se admite cambiar, revelar o restaurar secretos, ni modificar grupos de Library en esta versión.

La verificación de la huella es conservadora: si Azure normaliza otros campos inesperadamente, se detiene antes del redeploy. PUT y PATCH no forman una transacción. Si cambia un dato entre el último GET y el PUT, la API puede no ofrecer un control condicional equivalente a ETag: hay una ventana residual de concurrencia externa. Este producto no promete aislamiento distribuido. Para producción con varios operadores hace falta un coordinador compartido y validar las garantías de la API; el bloqueo local no cubre otros equipos o la UI de Azure.

## Redeploy y efectos posteriores

Esta versión solo implementa `environmentRedeploy` para stages de Classic Releases. No ejecuta una task interna de forma aislada y no deshabilita tareas, gates o triggers. Por defecto se rechazan dependencias de otros stages hacia el destino; `downstreamPolicy: allow` permite las conocidas con advertencia. Los environmentTriggers y tipos de condición desconocidos siempre se rechazan; ninguna dependencia se elimina automáticamente.

El control verifica la configuración incluida en la instancia. No puede detectar automatizaciones externas, service hooks o acciones de otros sistemas. El éxito representa el estado del despliegue en Azure; no prueba por sí solo la salud funcional de la aplicación. Health checks arbitrarios no están implementados.

El seguimiento identifica el intento esperado y no confunde el éxito del intento anterior con el nuevo. Si aparece uno posterior, detiene el seguimiento con estado incierto. La correlación por release/environment/intento sigue necesitando que no haya solicitudes externas simultáneas; el comentario de la solicitud incluye el ID de operación para inspección.

## Aprobaciones

`approvals: external` es el valor recomendado inicialmente. Las aprobaciones se realizan en Azure; el panel muestra las pendientes y el enlace del release. `explicit` habilita botones de decisión únicamente cuando el proceso también tiene `AZDO_ENABLE_APPROVALS=true` y escrituras habilitadas.

Cada decisión se revalida contra release, environment, intento y approvalId. Se requiere comentario. Azure decide elegibilidad, grupos, orden, restricciones sobre solicitantes y revalidación de identidad. El MCP no modifica aprobadores ni elimina controles. Si Azure exige autenticación interactiva o rechaza el PAT, aprueba en su interfaz.

Permisos documentados por los endpoints:

| Uso                                         | Scope API             |
| ------------------------------------------- | --------------------- |
| Leer releases y aprobaciones                | `vso.release`         |
| Actualizar instancia y solicitar despliegue | `vso.release_execute` |
| Aprobar/rechazar                            | `vso.release_manage`  |
| Lectura de proyectos de las tools básicas   | `vso.project`         |

Los scopes del PAT no sustituyen permisos del recurso y políticas de la organización. Las opciones del portal para PAT pueden agrupar permisos; revisa el alcance exacto antes de generar uno. Cada persona usa su credencial. No hay renovación automática ni credencial común embebida en YAML.

## Estado, interrupciones y recuperación

Estados principales: `planned → writing → variablesUpdated → requestingDeployment → tracking/awaitingApproval → succeeded/failed`. `conflict` impide aplicar un plan obsoleto. `uncertain`, `interrupted` y `trackingTimedOut` mantienen el bloqueo local del release hasta reconciliación explícita.

Cerrar el navegador no cancela nada. Cerrar el servidor detiene el seguimiento, pero no una operación ya aceptada por Azure. Al reiniciar se retoma la lectura de operaciones en seguimiento. No se repiten escrituras interrumpidas o con respuesta incierta. El panel permite reconocer que el operador revisó el estado en Azure, sin realizar cambios remotos; después puede prepararse una restauración.

Si aparece `STORE_LOCKED` después de un cierre abrupto: confirma primero que no existe otro servidor con ese directorio, respalda el estado y elimina únicamente el directorio vacío `coordinator.lock`. No borres la clave ni los registros. Reinicia y revisa las ejecuciones interrumpidas antes de liberar sus bloqueos. No hay desbloqueo automático por tiempo.

Los registros usan AES-256-GCM con una clave local separada, escritura mediante archivo temporal y rename, permisos POSIX restrictivos cuando aplican. En Windows los permisos efectivos dependen de las ACL del perfil: restringe el directorio al usuario. El cifrado no protege de alguien que acceda a la clave y los registros. No guardar el estado en Git, carpetas compartidas o sincronizadas. La versión inicial no tiene limpieza automática; conserva el historial necesario para rollback y elimina registros terminales solo como mantenimiento offline, con backup si se necesita auditoría. No es un registro de auditoría inmutable.

## Extender sin duplicar Microsoft

`ReleaseGateway` encapsula Azure. `OperationEngine` coordina políticas y estados. `RecordStore` permite reemplazar persistencia. `review-server` maneja HTTP local y `tools/operations` expone planificación/lectura. El adapter de demo implementa la misma interfaz sin red.

Para agregar una estrategia: ampliar el esquema con una unión discriminada, implementar su adapter, declarar efectos y añadir pruebas de rechazo, reanudación e idempotencia. No implementar fallback silencioso. Los scripts arbitrarios, secretos, Library, ejecución selectiva de tasks y coordinación distribuida requieren diseños separados. Para PRs, Boards y Test Plans, revisar primero el MCP oficial y preferir composición desde el cliente.

## Referencias oficiales

- [Releases List](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/releases/list?view=azure-devops-rest-7.1)
- [Deployments List](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/deployments/list?view=azure-devops-rest-7.1)
- [Release Update](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/releases/update-release?view=azure-devops-rest-7.1)
- [Environment Update](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/releases/update-release-environment?view=azure-devops-rest-7.1)
- [Approvals Update](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/approvals/update?view=azure-devops-rest-7.1)

## Resolución de targets

El catálogo permite definir `definition.name` y `environment.name` en lugar de IDs. Los ejemplos completos están en `examples/operations.yaml` (recomendado, nombres) y `examples/operations.ids.yaml` (avanzado, IDs). Ambos mantienen `schemaVersion: "1"`.

Cada target exige exactamente una referencia de definición (`definitionId` o `definition: { name: ... }`) y una referencia de environment (`definitionEnvironmentId` más `expectedName`, o `name`). Se pueden combinar definición por ID con environment por nombre, o viceversa, pero no mezclar dos formas dentro de la misma referencia.

El gateway consulta la [API oficial de definiciones](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/definitions/list?view=azure-devops-rest-7.1) con `searchText` e `isExactNameMatch=true`. También compara nombres literalmente en el cliente y recorre la paginación. No se normalizan espacios ni mayúsculas. Dos definiciones con el mismo nombre en carpetas diferentes son ambiguas: usa IDs para desambiguar. La búsqueda tiene un límite de 20 páginas de 100; si no puede terminar, devuelve `SEARCH_LIMIT` sin seleccionar un resultado parcial.

Después consulta la definición completa para obtener el ID del environment. Los errores `RELEASE_DEFINITION_NOT_FOUND`, `AMBIGUOUS_RELEASE_DEFINITION`, `ENVIRONMENT_NOT_FOUND` y `AMBIGUOUS_ENVIRONMENT` explican qué referencia corregir. Si la definición cambia de identidad o nombre entre ambas consultas, se devuelve `TARGET_CHANGED`.

No hay caché de resolución: cada plan nuevo consulta Azure. El plan persistido contiene el target canónico por IDs, y las guardas siguen validando el release y stage elegidos. Una modificación posterior de nombre no redirige un plan; los cambios relevantes en el release lo invalidan. Cambiar el catálogo también invalida su aplicación. El flujo antiguo con ambos IDs no agrega consultas de resolución. Las estrategias `latestCreated`, `latestSuccessfulDeployment` y `explicit` conservan su comportamiento.

## Prueba en Windows PowerShell

Desde la raíz de tu copia local, con Node en el PATH:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run format:check

# Crear archivos locales solo si todavía no existen.
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path operations.local.yaml)) {
    Copy-Item examples/operations.yaml operations.local.yaml
}
notepad.exe operations.local.yaml
notepad.exe .env
npm.cmd run catalog:validate -- operations.local.yaml
```

Reemplaza los nombres de organización, proyecto, definición y stage del YAML por los de tu entorno. Configura las credenciales en `.env`, que está excluido de Git. Añade allí `AZDO_OPERATIONS_FILE=C:/ruta/real/al/proyecto/operations.local.yaml` y conserva `AZDO_ENABLE_WRITES=false` y `AZDO_ENABLE_APPROVALS=false` para probar la resolución y revisión sin cambios en Azure.

Inicia Inspector desde la misma carpeta:

```powershell
npx.cmd -y @modelcontextprotocol/inspector node --env-file=.env dist/index.js
```

En `ado_plan_operation`, ejecuta:

```json
{ "operation": "integration-mode", "mode": "simulated" }
```

Abre el `reviewUrl` y verifica el release y stage concretos resueltos. El catálogo de ejemplo también requiere las variables indicadas: adáptalas a variables no secretas de tu release de prueba. Validar YAML no comprueba su existencia. Si prefieres Copilot, detén Inspector e inicia el servidor desde `.vscode/mcp.json`; ambas interfaces usan el mismo motor.

## Políticas explícitas de downstream y valores sin cambios

`deployment.downstreamPolicy` admite `reject` (predeterminado, comportamiento anterior) y `allow`. `allow` permite únicamente la dependencia conocida `environmentState` de otro stage hacia el seleccionado. El plan y el panel muestran `DOWNSTREAM_DEPENDENCY`, los IDs y nombres de los dependientes directos y la posibilidad de ejecuciones posteriores decididas por Azure. También se devuelven en las tools de planificación y estado. No implica que esos stages necesariamente vayan a ejecutarse ni que estén aislados; pueden existir dependencias transitivas. No se alteran condiciones, aprobadores, tareas ni triggers.

Se siguen rechazando triggers de environment, tipos de condición desconocidos, despliegues activos/queued/scheduled, releases inactivos o incorrectos, stages con identidad distinta y organizaciones fuera del allowlist. Las comprobaciones se repiten antes de escribir y antes del redeploy. Un cambio de dependencias tras la revisión invalida la huella del plan.

`deployment.redeployWhenUnchanged` es `false` por defecto y mantiene `NO_CHANGES` si todos los valores coinciden. Con `true`, puede prepararse y ejecutarse el plan: se omite la actualización de variables si todo está igual, se verifica otra vez el release y se solicita redeploy. Los resultados inciertos no se reintentan automáticamente. La restauración de una operación de este tipo puede volver a desplegar esos mismos valores. El rollback conserva la política original y presenta de nuevo las advertencias.

El resultado `succeeded` corresponde solo al intento del stage seleccionado, no al estado de todos sus descendientes. Si un stage posterior sigue activo, las guardas bloquearán nuevas operaciones o restauraciones sobre ese release hasta que termine. El panel muestra las capacidades actuales del proceso; las tools no habilitan escrituras ni aprobaciones.

## Consultas y prueba con Copilot

Las tres tools nuevas no requieren catálogo ni permisos de escritura: usan lectura de Releases (`vso.release`) y los permisos del usuario sobre el recurso. `organization` y `project` usan los valores de configuración cuando se omiten, respetando `AZDO_ALLOWED_ORGANIZATIONS` antes de cualquier petición.

`ado_list_releases` acepta filtros opcionales `definitionId` o `definitionName` (nunca ambos), `status` (`active`, `draft`, `abandoned`), `sourceBranch` como `refs/heads/main`, `top` (1–100, predeterminado 50) y `continuationToken`. Devuelve `items` y token cuando haya otra página. Para continuar usa los mismos filtros y el token anterior. Sin `status` se usa el comportamiento de listado de Azure. Los datos se proyectan a una lista permitida de campos; jamás se devuelve el release crudo.

`ado_get_release` recibe `releaseId`. `ado_get_latest_release` exige exactamente `definitionId` o `definitionName`; su estrategia predeterminada es `latestCreated`. Para `latestSuccessfulDeployment` se requiere `environmentName`. Ambas estrategias llaman a la misma selección que OperationEngine. `selection: explicit` en YAML sigue seleccionando directamente el ID y las guardas verifican su pertenencia y estado; para consulta directa usa `ado_get_release`.

Los nombres son literales, no apodos ni búsquedas aproximadas. Primero consulta las definiciones si desconoces el nombre exacto. Las tools de variables originales consultan la definición, no los valores de una instancia; las nuevas tools de lectura de releases no devuelven variables. El plan sí lee las variables de la instancia elegida y muestra las no secretas afectadas en la revisión local.

Ejemplos de prompts usando el catálogo genérico de `examples/operations.services.yaml`:

- «Usa ado_get_latest_release para consultar el último release activo de Example Catalog Service y mostrar su releaseId, fecha y stages».
- «Usa ado_list_releases para listar los últimos 5 releases activos de Example Identity Service».
- «Consulta el release con ID 987 y muestra el estado de Deploy Certification» (reemplaza el ID por uno obtenido de Azure).
- «Prepara catalog-mocks en modo enabled y dame el enlace de revisión y sus advertencias».
- «Prepara catalog-mocks en modo disabled y dame el enlace de revisión».
- «Prepara identity-mocks en modo enabled y dame el enlace de revisión».
- «Prepara identity-mocks en modo disabled y dame el enlace de revisión».

En PowerShell, desde la raíz del proyecto:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build
npm.cmd run format:check
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path operations.local.yaml)) {
    Copy-Item examples/operations.services.yaml operations.local.yaml
}
notepad.exe operations.local.yaml
notepad.exe .env
npm.cmd run catalog:validate -- operations.local.yaml
```

Si ya existe el catálogo local, adáptalo sin sobrescribirlo: usa destinos y variables reales no secretas, y añade las políticas deseadas. En `.env`, configura `AZDO_OPERATIONS_FILE` con su ruta absoluta y conserva inicialmente `AZDO_ENABLE_WRITES=false` y `AZDO_ENABLE_APPROVALS=false`. No se necesita habilitar escrituras para consultar, planificar o revisar. Inicia o reinicia `azure-devops-classic` desde `.vscode/mcp.json` y habilita sus herramientas en Copilot. Hay 10 tools de lectura siempre disponibles y 6 de operaciones cuando se configura el catálogo (16 en total).

Tras verificar el plan, las advertencias y permisos en un release de prueba, habilitar `AZDO_ENABLE_WRITES=true` y reiniciar permite aplicar únicamente desde el panel. Esto no habilita decisiones de aprobación: requieren además el flag y la política explícitos existentes. No ejecutes Inspector y Copilot simultáneamente contra el mismo estado. Las pruebas automatizadas usan datos sintéticos; no prueban las políticas ni el disparo de stages de tu organización.

Referencias oficiales: [listado de releases](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/releases/list?view=azure-devops-rest-7.1) y [listado de definiciones](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/definitions/list?view=azure-devops-rest-7.1).
