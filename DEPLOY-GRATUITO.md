# deploy gratuito do whatsapp agent monitor

este projeto usa Baileys, então não precisa de Chromium/Puppeteer. fica leve para hospedagem gratuita.

## arquitetura recomendada

- Render Free Web Service para rodar o monitor
- Supabase Free para persistir sessão do WhatsApp, histórico e agentes gerados
- Google Gemini API key gratuita para extração das tarefas

## 1. criar banco gratuito no Supabase

1. crie uma conta em https://supabase.com
2. crie um projeto free
3. vá em Project Settings > Database
4. copie a connection string em modo URI, preferindo a opção com pooler na porta 6543
5. troque `[YOUR-PASSWORD]` pela senha do banco

use essa string como `DATABASE_URL` no Render. para este projeto, a conexão local já foi validada com Supabase.

## 2. subir no Render

1. crie uma conta em https://render.com
2. crie um novo Web Service usando este repositório
3. escolha Docker como runtime
4. plano Free
5. adicione estas variáveis de ambiente:

```env
GEMINI_API_KEY=sua_chave_gemini
DATABASE_URL=postgresql://postgres.qsovxfpjsgkvqlydwtfo:SUA_SENHA@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true
DATABASE_SSL=true
GROUP_ESCOLA_1=Ecilda Ramos 2026
GROUP_ESCOLA_2=Professores - Tiradentes
GROUP_IGREJA=Ministro e Obreiros IIGD BV
CONTACT_ESPOSA=Rafaelly
CONTACT_PASTOR=PR Josehilton
CONTACT_EU=
HOURS_LOOKBACK=12
PORT=3001
```

## 3. conectar o WhatsApp

1. abra a URL pública do Render
2. escaneie o QR pelo WhatsApp no celular
3. clique em executar agora para testar

## observação importante

serviços gratuitos podem dormir quando ficam sem acesso. o projeto inclui keep-alive quando `RENDER_EXTERNAL_URL` ou `APP_URL` existe, mas planos gratuitos podem ter limites da plataforma.

a sessão do WhatsApp não deve sumir, porque fica salva no Supabase.
