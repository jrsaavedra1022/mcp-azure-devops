# Contribuir

Usa Node 22 o 24, `npm ci` y `npm run check`. Ejecuta `npm run format` antes de enviar cambios. Mantén las herramientas separadas de transporte, políticas y adapters. Incluye pruebas de comportamiento y seguridad relevantes con fixtures sintéticos. Nunca agregues credenciales ni identificadores corporativos.

Antes de implementar un dominio nuevo, revisa la cobertura del MCP oficial de Microsoft. Las escrituras requieren un diseño separado, pruebas de concurrencia/idempotencia y autorización explícita; no amplíes silenciosamente las herramientas de lectura.
