# Puesta en marcha

Pasos en orden. Lo que dice **(tú)** necesita tus cuentas o tu tarjeta; el resto ya está en el repo. Después de cada paso, `npm run doctor` te dice qué falta.

Tiempo total: unas 3 horas repartidas en 2–3 días, más 2–3 semanas de calentamiento de correo que corren en paralelo.

## 0. Hoy mismo, porque tardan

- [ ] **(tú) Revisa tu contrato con Viant**: cláusulas de propiedad intelectual y de trabajo externo. Trabaja solo fuera de horario y en tu computadora.
- [ ] **(tú) Inicia la LLC en EE.UU. y pide el EIN.** Sin ellos no hay pasarela de pagos ni registro de SMS. Pueden tardar varias semanas.
- [ ] **(tú) Dominios de correo frío**: compra 2 dominios parecidos a tu marca, crea 2 buzones en cada uno (Google Workspace), configura SPF, DKIM y DMARC, y conéctalos a Instantly para que empiecen a calentar.

## 1. Clave de Claude

- [ ] **(tú)** Entra a console.anthropic.com, agrega créditos y crea una API key.
- [ ] **(tú)** En Billing, pon un límite de gasto mensual (por ejemplo $50) para que un error no te cueste caro.
- [ ] En tu computadora: `cp .env.example .env`, pega la clave en `ANTHROPIC_API_KEY` y corre `npm run doctor`. Debe decir "La clave funciona".

## 2. Prueba el bot con Claude de verdad

- [ ] `npm start` y abre http://localhost:3000/?client=demo-hvac. Agenda una cita y mira el panel.
- [ ] `npm run qa -- --client demo-hvac`. Deberían pasar los 11 escenarios. Si alguno falla, lee la conversación en `data/qa/` y ajusta `src/prompt.js` (o pídeme ayuda con el reporte).
- [ ] Anota cuánto cuesta una conversación: la consola imprime los tokens de cada mensaje.

## 3. Servidor en Render

- [ ] **(tú)** Crea una cuenta en render.com y conecta tu GitHub.
- [ ] **(tú)** New → Blueprint → elige el repo `AI-B2B`. Render lee `render.yaml`: plan Starter con un disco de 1 GB en `/var/data`. Necesitas un plan de pago para tener disco; sin disco, los clientes publicados se borran en cada deploy. Revisa el precio actual en Render.
- [ ] **(tú)** Llena las variables que pide: `ANTHROPIC_API_KEY` y, por ahora, `PUBLIC_URL` con cualquier valor. `ADMIN_TOKEN` se genera solo.
- [ ] Cuando termine el primer deploy, copia la URL del servicio (algo como `https://ai-receptionist.onrender.com`), ponla en `PUBLIC_URL` y vuelve a desplegar.
- [ ] **(tú)** Copia el `ADMIN_TOKEN` de la pestaña Environment y guárdalo en tu gestor de contraseñas.
- [ ] Abre `<PUBLIC_URL>/?client=demo-hvac` desde tu celular y chatea. Esa es la demo que vas a mandar a los prospectos.

## 4. Flujos de n8n

En la carpeta `n8n/` hay tres flujos listos para importar (Workflows → Import from File):

| Archivo | Qué hace | Variable del servidor |
|---|---|---|
| `receptionist-client-alerts.json` | Le manda al dueño un correo por cada cita, lead y alerta urgente (a ti con copia en las urgentes) | `WEBHOOK_URL` |
| `receptionist-onboarding.json` | Te avisa cuando un cliente envía el formulario y cuando está listo para revisar; al cliente le manda los cambios pedidos y el correo de bienvenida con el código del widget | `ONBOARDING_WEBHOOK_URL` |
| `receptionist-monthly-reports.json` | El día 1 de cada mes, a las 8 AM, genera y envía el reporte de cada cliente | (usa `ADMIN_TOKEN`) |

Para cada uno:
- [ ] **(tú)** Importa el archivo y elige tu credencial de Gmail en cada nodo de Gmail.
- [ ] Reemplaza los textos `REPLACE_WITH_...` (tu correo, la URL del servidor y el `ADMIN_TOKEN`). La nota amarilla de cada flujo dice dónde están.
- [ ] Activa el flujo, abre el nodo Webhook y copia la **Production URL** (no la Test URL).
- [ ] Pégala en Render como `WEBHOOK_URL` u `ONBOARDING_WEBHOOK_URL` y vuelve a desplegar.

Estos archivos se escribieron a mano y no se han importado en una cuenta real. Si n8n marca un error en algún nodo al importar, ábrelo, revisa sus campos o vuelve a crearlo con los mismos valores. La tabla de eventos del README dice qué campos trae cada uno.

## 5. Verificación completa

- [ ] En Render → Shell (o en tu computadora, con los mismos valores en `.env`): `npm run doctor -- --ping`. Llama al servidor público y manda un evento de prueba a cada webhook. Revisa en n8n → Executions que llegaron.
- [ ] **Ensayo con un cliente falso**, usando tu propio correo como si fueras el dueño:
  1. `npm run onboard -- --business "Test Plumbing" --email TU_CORREO` (en el Shell de Render).
  2. Abre el enlace del formulario, llénalo y envíalo. Te debe llegar "Formulario recibido" y, unos minutos después, "Listo para revisar".
  3. Abre la revisión y publica. Te debe llegar el correo de bienvenida con el código del widget.
  4. Abre `<PUBLIC_URL>/?client=test-plumbing`, agenda una cita y escribe "I smell gas". Te deben llegar el correo de la cita y la alerta urgente.
  5. Borra el cliente de prueba: `rm /var/data/clients/test-plumbing.json` en el Shell.

## 6. Prospección

- [ ] **(tú)** En Outscraper, crea la API key y ponla en `.env` como `OUTSCRAPER_API_KEY`.
- [ ] **(tú)** Haz una búsqueda nueva solo con "HVAC contractor", "air conditioning repair service", "plumber" y "water heater repair", por código postal de Houston y San Antonio.
- [ ] En tu computadora: `npm run prospects -- --input <archivo> --batch <nombre> --top 10 --enrich --personalize --demos` con `PUBLIC_URL` apuntando a Render. Revisa `revision.csv`.
- [ ] Las demos se crean en `clients/`. Haz commit y push para que Render las publique, y abre 2 o 3 enlaces para revisarlas.
- [ ] **(tú)** Cuando los dominios lleven al menos 2 semanas calentando, sube `instantly.csv` a Instantly con la secuencia de correos del plan.

## 7. Cuando tengas la LLC y el EIN

- [ ] **(tú)** Cuenta bancaria y pasarela de pagos. Crea los enlaces de pago del piloto ($297/mes) y del Starter.
- [ ] **(tú)** Twilio: registro A2P 10DLC. Cuando lo aprueben, agrega un nodo de SMS después de "Urgent alert" en el flujo de alertas, con destino `body.alerts.phone`.
- [ ] Pídeme el paso de cobro automático: pago recibido → invitación de onboarding enviada sola.
