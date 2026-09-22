# Azure DevOps Classic MCP

Servidor MCP genérico de solo lectura para Azure DevOps Services, implementado en TypeScript sobre el SDK oficial de MCP. Admite cualquier organización y proyecto accesibles con la credencial configurada. No contiene identificadores corporativos, PAT ni endpoints internos.

## Alcance

| Herramienta                         | Resultado                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `ado_list_organizations`            | Organizaciones desde Accounts API para un memberId explícito, según credenciales y allowlist |
| `ado_list_configured_organizations` | Organizaciones de la configuración local; no descubre membresías ni verifica acceso          |
| `ado_list_projects`                 | Una página de proyectos accesibles                                                           |
| `ado_list_release_definitions`      | Una página de definiciones de Classic Releases                                               |
| `ado_get_release_definition`        | Metadatos seguros, revisión, environments y referencias a variable groups                    |
| `ado_list_release_environments`     | Environments de una definición Classic Release                                               |
| `ado_get_release_variables`         | Variables directas globales o de un environment; valores ocultos por defecto                 |

No expone operaciones de escritura. Los environments son etapas de Classic Releases, no recursos de YAML Environments. No enumera instancias de releases, resuelve variable groups, expande Key Vault ni calcula variables efectivas heredadas. La paginación es explícita: envía el `continuationToken` devuelto en la siguiente llamada; omitirlo reinicia la consulta.

## Relación con el MCP oficial

Microsoft proporciona un [MCP oficial](https://github.com/microsoft/azure-devops-mcp), con servidor remoto y local, para capacidades generales de Azure DevOps. Conviene usarlo para los dominios que cubra y conectar este servidor como complemento para Classic Releases o políticas específicas de lectura. Revisa su catálogo de herramientas al incorporar capacidades nuevas: su cobertura cambia.

Este proyecto reutiliza el [SDK oficial de MCP](https://ts.sdk.modelcontextprotocol.io/) y las APIs REST oficiales de Azure DevOps. No hace fork del servidor de Microsoft ni lo ejecuta como subproceso. La coexistencia es a nivel del cliente MCP, con nombres `ado_*` propios. Un adapter REST pequeño permite controlar hosts, proyección de respuestas y secretos sin añadir una segunda abstracción del SDK Azure.

## Requisitos y arranque

Node.js 22 o 24 LTS y npm. Una cuenta con permisos de lectura en los recursos solicitados.

```sh
npm ci
cp .env.example .env
# Editar .env localmente: organización/proyecto genéricos y credencial propia.
npm run check
node --env-file=.env dist/index.js
```

El servidor espera mensajes MCP por stdin; que no imprima un menú es normal. stdout queda reservado al protocolo y los logs van a stderr. `.env` no se carga automáticamente: usa `--env-file` o inyecta las variables desde tu gestor de secretos. Evita poner tokens en argumentos, chats o archivos versionados.

Para desarrollo: `npm run dev` con las variables ya presentes en el entorno. Para cargar `.env` explícitamente: `node --env-file=.env --import tsx src/index.ts`.

## Autenticación y permisos

Configura exactamente uno de `AZDO_PAT` o `AZDO_BEARER_TOKEN`. El PAT se transmite mediante Basic sobre HTTPS; Bearer admite un access token válido de Microsoft Entra para Azure DevOps. No se implementan login interactivo ni renovación automática: el proveedor de credenciales debe encargarse del ciclo de vida del token y reiniciar el proceso cuando cambie.

Para PAT, concede únicamente **Project and Team: Read** (`vso.project`) y **Release: Read** (`vso.release`), además de los permisos de recursos requeridos por Azure DevOps. No necesita permisos de escritura ni ejecución. Un PAT limitado a una organización no adquiere acceso a otras por configurar sus nombres. Prefiere credenciales de corta duración y un proceso/credencial por límite de confianza.

`ado_list_configured_organizations` devuelve configuración con `verified: false`. Para consultar organizaciones reales, `ado_list_organizations` usa [Accounts List](https://learn.microsoft.com/en-us/rest/api/azure/devops/account/accounts/list?view=azure-devops-rest-7.1) con `memberId` UUID explícito y filtra la salida por allowlist. Esta API exige autorización compatible con lectura de perfil (`vso.profile`) y contexto de identidad; un PAT limitado a una organización puede no funcionar. Los errores de autorización se devuelven explícitamente: no se sustituyen por una lista local. El UUID de miembro es la identidad de perfil Azure DevOps; no asumas que coincide con el object ID de Entra.

Ejemplo de argumentos para esta consulta: `{ "memberId": "11111111-1111-4111-8111-111111111111" }` (reemplaza el UUID sintético por el de tu perfil).

## Configuración

| Variable                     | Predeterminado | Uso                                                                      |
| ---------------------------- | -------------- | ------------------------------------------------------------------------ |
| `AZDO_PAT`                   | —              | PAT; excluyente con Bearer                                               |
| `AZDO_BEARER_TOKEN`          | —              | Access token; excluyente con PAT                                         |
| `AZDO_ORGANIZATION`          | —              | Organización por defecto; se puede indicar en cada tool                  |
| `AZDO_PROJECT`               | —              | Nombre o GUID del proyecto por defecto                                   |
| `AZDO_ALLOWED_ORGANIZATIONS` | vacío          | Lista separada por comas; vacía permite cualquier organización accesible |
| `AZDO_TIMEOUT_MS`            | `15000`        | Timeout por intento, entre 100 y 120000 ms                               |
| `AZDO_MAX_RETRIES`           | `2`            | Reintentos adicionales, entre 0 y 3                                      |
| `AZDO_LOG_LEVEL`             | `error`        | `silent`, `error` o `info`                                               |

La configuración se valida al arrancar sin imprimir valores inválidos. La allowlist restringe las tools aunque se envíe otra organización. No hay allowlist de proyectos: los permisos Azure de la identidad delimitan el acceso. La versión REST está centralizada en el cliente (`7.1`). Solo se admite Azure DevOps Services público; Azure DevOps Server on-premise y nubes soberanas requieren un adapter y una política de hosts dedicados.

## Configuración en un cliente MCP

Ejemplo para clientes que usan `mcpServers` (adapta la ruta absoluta). El archivo `.env` queda fuera de este JSON y de Git:

```json
{
  "mcpServers": {
    "azure-devops-classic": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/mcp-azure-devops/.env",
        "/absolute/path/mcp-azure-devops/dist/index.js"
      ]
    }
  }
}
```

En VS Code el contenedor es `servers` y se agrega `type: "stdio"` al servidor. Para conectar también el MCP oficial, agrega una entrada separada siguiendo su documentación. No se instala ni configura automáticamente en ningún cliente.

## Ejemplos de argumentos

Listado paginado:

```json
{ "organization": "example-org", "project": "Example Project", "top": 25 }
```

Detalle de definición:

```json
{
  "organization": "example-org",
  "project": "Example Project",
  "definitionId": 123
}
```

Variables globales (sin valores):

```json
{ "definitionId": 123 }
```

Variables directas de un environment, incluyendo únicamente valores explícitamente no secretos:

```json
{ "definitionId": 123, "environmentId": 456, "includeValues": true }
```

Los IDs deben ser enteros positivos Int32, no strings. `environmentId` selecciona un ID, evitando ambigüedad por nombres repetidos. Sin environment se consulta el ámbito global; no se fusionan ámbitos.

## Arquitectura

```text
Cliente MCP → tools → servicios → DevOpsReader → AzureDevOpsAdapter → RestClient → Azure DevOps
                         ↑                                            ↑
                    configuración                             autenticación / logging
```

- `src/config.ts`: validación tipada y credencial de proceso.
- `src/client/`: transporte GET, hosts fijos, codificación de rutas, timeout, reintentos limitados y errores sanitizados.
- `src/adapters/`: endpoints oficiales y validación de respuestas con Zod; elimina campos no requeridos.
- `src/services/`: resolución de ámbito, allowlist, proyección de metadatos y política de variables.
- `src/tools/`: schemas de entrada, anotaciones read-only y traducción de errores a resultados MCP.
- `src/server.ts`: composición e inyección del adapter para pruebas.
- `src/index.ts`: transporte stdio y cierre del proceso.

Los datos de Azure son contenido externo, no instrucciones para el agente. Los errores MCP usan `isError` y códigos seguros; no se retransmiten cuerpos de error remotos, headers ni excepciones originales. El logger acepta eventos predefinidos y estado HTTP exclusivamente.

## Seguridad y límites operativos

Los valores se omiten por defecto. Con `includeValues: true`, se muestran únicamente variables con `isSecret: false` explícito; si el campo falta, el valor sigue oculto. Variables marcadas secretas jamás devuelven valor aunque Azure lo enviara. Nombres y metadatos siguen siendo información interna: usa un cliente MCP de confianza. Las respuestas de detalle/listado no incluyen scripts de tasks ni la definición cruda.

Se rechazan redirecciones; las tools no aceptan URL ni método arbitrario. Las rutas se codifican y los hosts son fijos. Se reintentan solo 429/502/503/504 hasta el límite configurado, respetando `Retry-After` en segundos o fecha. Si solicita más de 30 segundos, la llamada falla y permite reintentar más tarde. No hay reintentos de errores de autenticación ni transporte. Timeout por intento y máximo de reintentos acotan la espera; no hay caché, persistencia ni límite global de concurrencia. Las respuestas de definiciones grandes se procesan en memoria: esta versión es un servidor local, no un servicio HTTP multiusuario.

## Verificación y scripts

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
npm run check
```

`npm run format` aplica formato. `npm start` usa la compilación y variables del entorno. `prepack` ejecuta verificaciones antes de empaquetar. Las pruebas usan fixtures sintéticos y fetch inyectado, sin credenciales reales ni acceso Azure: cubren scopes, secretos, reintentos, paginación, errores y cliente/servidor MCP oficial en memoria. CI ejecuta los checks con Node 22 y 24. Antes de operar en una organización real, realiza una prueba de lectura con un PAT mínimo para validar permisos y respuestas de esa cuenta.

## Extensión futura: updates y redeploy

Mantén `DevOpsReader` de solo lectura. Introduce interfaces separadas `ReleaseDefinitionWriter` y `ReleaseExecutionService`, además de tools distintas y una habilitación explícita de escritura desactivada por defecto.

Para actualizar variables: leer la revisión actual, preparar diff sin secretos, validar ámbito y revisión inmediatamente antes de escribir, preservar campos de la definición y variables secretas sin convertir valores omitidos en null. Verificar experimentalmente las garantías de concurrencia de la API elegida; no asumir que un GET/PUT es atómico. Agregar pruebas de conflicto y política de autorización antes de habilitarlo.

Para redeploy: trabajar con **releaseId** y el environment de una instancia de release, no solo con definitionId. Mantener aprobaciones, gates, permisos y estados de Azure; no evadirlos. Definir validación de objetivo, confirmación del cambio concreto, auditoría sin secretos y protección contra ejecuciones duplicadas. No reintentar automáticamente escrituras o despliegues sin garantías de idempotencia. Ninguna de estas operaciones está implementada ni expuesta hoy.

## Publicación y contribución

Proyecto independiente, licencia MIT. `private: true` evita una publicación accidental en npm y no impide publicarlo en GitHub. Incluye `package-lock.json` para instalaciones reproducibles. Revisa `git diff --cached` antes de subir y confirma que `.env`, tokens y datos reales no estén incluidos. Crea el repositorio remoto con el nombre/propietario que elijas y sube únicamente el código revisado. No se crea un remoto ni se publica automáticamente.

Para npm en el futuro, elige un nombre disponible, revisa licencia y metadatos, cambia `private`, ejecuta `npm pack --dry-run` y publica solo después de revisar el paquete.

## Diagnóstico

- Arranque fallido: verifica credencial única, rangos de configuración y ruta de `.env`.
- 401: token ausente, inválido o vencido.
- 403: scopes del token o permisos sobre el recurso insuficientes.
- 404: organización/proyecto/ID incorrectos o recurso no visible para la identidad.
- Variables sin valor: comportamiento esperado para secretos, flags de secreto ausentes o `includeValues: false`.
- Lista de organizaciones vacía: configura organización por defecto o allowlist; no es un error de autenticación.
- Error de transporte: comprueba conectividad HTTPS y certificados de confianza del equipo; no desactives TLS.

## Referencias oficiales

- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/)
- [Azure DevOps MCP de Microsoft](https://github.com/microsoft/azure-devops-mcp)
- [Projects List](https://learn.microsoft.com/en-us/rest/api/azure/devops/core/projects/list?view=azure-devops-rest-7.1)
- [Release Definitions List](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/definitions/list?view=azure-devops-rest-7.1)
- [Release Definitions Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/release/definitions/get?view=azure-devops-rest-7.1)
