# Azure DevOps Classic MCP

Servidor TypeScript para consultar Classic Releases y gestionar operaciones recurrentes de variables y redeploy con revisión local obligatoria. Complementa al MCP oficial de Microsoft. Genérico para cualquier organización de Azure DevOps Services; sin datos corporativos ni secretos embebidos.

La versión 0.2 añade un catálogo YAML, planes ligados a un release concreto, un panel local, seguimiento de aprobaciones y restauración. Las siete herramientas de lectura originales siguen disponibles y se añaden tres consultas de instancias de release sin necesidad de catálogo. Las escrituras están deshabilitadas por defecto. Estado: **preview; verificar integración en un release de prueba antes de producción**.

## Inicio rápido

Node 22.13+ o 24 LTS; para Inspector y certificados del sistema recomendamos Node 24 LTS.

```sh
npm ci
npm run check
npm run demo
```

Abre la URL impresa para probar el panel con datos sintéticos, sin Azure ni PAT. Revisa un cambio, aplícalo y prepara su restauración.

Para uso real:

```sh
cp .env.example .env
cp examples/operations.yaml operations.local.yaml
npm run catalog:validate -- operations.local.yaml
npm run build
node --env-file=.env dist/index.js
```

Edita `.env` y el catálogo antes de conectar. Los ejemplos tienen nombres e IDs ficticios. No se cargan archivos `.env` automáticamente. Consulta [la guía completa de operaciones](docs/OPERATIONS.md) para configuración, permisos, restricciones y recuperación. La configuración de lectura original se documenta en [READ_ONLY.md](docs/READ_ONLY.md); sus referencias a solo lectura describen ese módulo original.

## Copilot en VS Code

El repositorio incluye [`.vscode/mcp.json`](.vscode/mcp.json). Abre la carpeta raíz del proyecto en VS Code, crea y configura `.env` a partir de `.env.example` y ejecuta `npm ci` y `npm run build`.

Abre `.vscode/mcp.json` y pulsa **Start**, o usa **MCP: List Servers** desde la paleta de comandos para iniciar `azure-devops-classic`. Acepta la confianza del servidor cuando VS Code la solicite. En Copilot Chat, selecciona el modo Agent y habilita las herramientas del servidor. Puedes probar con: «Lista los proyectos disponibles en Azure DevOps».

La configuración usa Node desde el PATH y carga el `.env` local; no contiene credenciales. Si usas Node portable en Windows, asegúrate de que VS Code herede su PATH (cierra todas sus ventanas y vuelve a abrirlo después de cambiarlo). Alternativamente, configura el servidor en tu perfil de usuario con la ruta absoluta a `node.exe`; evita guardar rutas personales en el archivo compartido y no inicies ambas configuraciones a la vez.

Reinicia el servidor después de recompilar o cambiar `.env`. Para las operaciones YAML, consulta [la guía de operaciones](docs/OPERATIONS.md#uso-con-copilot). No ejecutes Inspector y Copilot simultáneamente contra el mismo directorio de estado.

Esta configuración corresponde a Copilot en VS Code; Copilot CLI utiliza su propia configuración. Referencia: [administrar servidores MCP en VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## Targets por nombre o por ID

La forma recomendada evita buscar IDs manualmente:

```yaml
definition:
  name: Example Application
environment:
  name: Deploy Certification
```

La forma avanzada sigue siendo compatible:

```yaml
definitionId: 123
environment:
  definitionEnvironmentId: 456
  expectedName: Deploy Certification
```

Usa una sola forma para cada referencia. Durante la planificación, el gateway resuelve nombres exactos (incluidas mayúsculas y espacios) y rechaza resultados ausentes o ambiguos. El plan guarda IDs concretos; ejecución, seguimiento y restauración no vuelven a resolver nombres. Cambiar el catálogo invalida un plan pendiente.

[`examples/operations.yaml`](examples/operations.yaml) muestra nombres; [`examples/operations.ids.yaml`](examples/operations.ids.yaml) muestra IDs. `catalog:validate` comprueba ambos formatos sin conectarse a Azure. La existencia se verifica al planificar. Consulta [los pasos para Windows](docs/OPERATIONS.md#prueba-en-windows-powershell).

## Capacidades

| Módulo       | Alcance                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| Lectura      | Organizaciones, proyectos, definiciones Classic, environments y variables            |
| Catálogo     | YAML estricto, modos permitidos, variables globales/de stage y targets configurables |
| Selección    | Último creado activo, historial de despliegues exitosos o release explícito          |
| Plan         | IDs fijos, diff no secreto, artefactos, caducidad y huella del catálogo y release    |
| Revisión     | Interfaz local protegida, decisión explícita, estado e historial                     |
| Ejecución    | Actualizar variables de la instancia y solicitar redeploy del environment            |
| Aprobaciones | Espera externa; decisión explícita opcional con permisos de Azure                    |
| Restauración | Valores anteriores y ausencia original, mismo release, revisión y nuevo redeploy     |

No ejecuta una task interna aislada. No modifica definiciones, Library o secretos. Por defecto rechaza dependencias de stages; `downstreamPolicy: allow` permite dependencias conocidas con advertencia, sin modificarlas. Git Flow y trunk-based usan el mismo motor con destinos explícitos.

## Consultar releases desde Copilot

Disponibles incluso sin `AZDO_OPERATIONS_FILE`:

- `ado_list_releases`: página de releases ordenados del más reciente al más antiguo, con `top`, `continuationToken`, filtros por definición, estado y rama.
- `ado_get_release`: metadata de una instancia por `releaseId`.
- `ado_get_latest_release`: último release activo por `definitionName` exacto o `definitionId`; usa `latestCreated` por defecto. `latestSuccessfulDeployment` exige `environmentName` y consulta el historial de despliegues exitosos.

Organización y proyecto son opcionales si están configurados en `.env`. Las respuestas incluyen fechas, stages, intentos cuando estén disponibles y referencias de artefactos permitidas. No exponen variables, tareas, logs, URLs de descarga ni campos arbitrarios. Si un campo no está disponible, se omite. La selección del último release se comparte con el motor de operaciones.

Ejemplo: «Usa ado_get_latest_release para consultar el último release de Example Catalog Service». No hace falta crear una operación para consultar.

## Tools de operaciones

`ado_list_operations`, `ado_plan_operation`, `ado_get_operation_status`, `ado_list_operation_executions`, `ado_open_operation_review`, `ado_plan_operation_rollback`.

Se registran únicamente si `AZDO_OPERATIONS_FILE` está configurado. Copilot prepara y devuelve un enlace de revisión; la escritura se autoriza en el panel. Inspector puede usar las mismas herramientas. Una sola instancia de producción por directorio de estado.

## Desarrollo

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
```

`npm run format` aplica formato. `npm run check` reúne tipos, lint, pruebas y build. CI ejecuta Node 22 y 24. Las pruebas usan datos sintéticos y no acceden a Azure.

- [Guía de operaciones y seguridad](docs/OPERATIONS.md)
- [Arquitectura y decisiones](docs/ARCHITECTURE.md)
- [Configuración básica de lectura](docs/READ_ONLY.md)
- [Cómo contribuir](CONTRIBUTING.md)
- [Seguridad](SECURITY.md)
- [Ejemplo YAML](examples/operations.yaml)

El proyecto usa el SDK oficial MCP y las APIs REST de Azure DevOps. El servidor MCP oficial de Microsoft se configura separadamente en el cliente para repositorios, PRs, Boards y Test Plans. No lo importamos ni ejecutamos como subproceso.

## Límites importantes

Las comprobaciones previas no eliminan la ventana entre GET y PUT frente a cambios de otros equipos. No hay transacción distribuida ni coordinación entre máquinas. Un error de escritura puede significar que Azure la aplicó: se registra como incierto y no se repite. El registro local está cifrado, pero su clave vive en el mismo perfil del usuario. El enlace de revisión es privado y no prueba presencia humana frente a procesos con acceso al mismo usuario.

La integración real con Azure, preservación de secretos no editados y políticas corporativas debe verificarse antes de habilitar escritura. Ningún PAT se incluye en el repositorio. `private: true` evita publicación accidental en npm; el código es publicable en GitHub bajo MIT.

## Políticas de redeploy

```yaml
deployment:
  strategy: environmentRedeploy
  downstreamPolicy: allow
  redeployWhenUnchanged: true
```

Ambas opciones son opt-in: por defecto son `reject` y `false`. Con `allow`, Azure puede disparar stages posteriores según su configuración; el panel muestra los dependientes directos y el seguimiento se limita al stage elegido. No se modifican dependencias ni se permiten triggers desconocidos. Con `redeployWhenUnchanged: true`, los valores iguales aparecen como «Sin cambios» y se puede solicitar redeploy sin ejecutar un PUT de variables.

Consulta [`examples/operations.services.yaml`](examples/operations.services.yaml) para un catálogo genérico de dos servicios y [la guía de prueba con Copilot](docs/OPERATIONS.md#consultas-y-prueba-con-copilot). El panel indica si las escrituras están habilitadas y desactiva el botón cuando no lo están; el backend siempre vuelve a validar ese permiso.
