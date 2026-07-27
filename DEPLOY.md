# Deploy — Transcrever PT-BR → GitHub → Cloudflare Workers

## O que esse projeto é (importante)

Diferente do **NestCNC** (SPA pura em Vite), este projeto usa **TanStack Start**
(SSR, via **Nitro**). Isso muda o alvo de deploy no Cloudflare:

- NestCNC → **Cloudflare Pages / Workers estático** (só arquivos).
- Transcrever PT-BR → **Cloudflare Workers "module"** (roda um servidor de
  verdade dentro do Worker, feito pelo Nitro com o preset `cloudflare-module`).

A boa notícia: toda a transcrição roda **no navegador** (Whisper via
`@huggingface/transformers`, dentro de um Web Worker — `transcribe.worker.ts`).
Não há chamadas a Supabase, API keys ou variáveis `VITE_*` nesse projeto — então
não precisa configurar nenhum "Environment Variable" no Cloudflare para ele
funcionar.

## O que eu revisei/ajustei

1. **`.git` quebrado**: o zip exportado do Lovable trazia um `.git` apontando
   pra um worktree que só existe no sandbox deles. Removi e reiniciei um repo
   git limpo.
2. **`wrangler.jsonc`** (novo, na raiz): fixa o nome do Worker
   (`transcrever-pt-br`) e a `compatibility_date`/`nodejs_compat`. Sem isso o
   Nitro geraria um nome aleatório a cada build.
3. **`package.json`**: adicionei `wrangler` como devDependency e os scripts
   `deploy` e `cf:preview`.
4. **Build validado**: rodei `npm install` + `npm run build` +
   `wrangler deploy --dry-run` aqui mesmo — compila e gera
   `.output/server/wrangler.json` corretamente (preset `cloudflare-module`,
   assets em `.output/public`).

> Nota: na minha máquina de teste, `npm install` falhou no *postinstall* do
> pacote `onnxruntime-node` (tenta baixar um binário do NuGet e meu sandbox
> bloqueia esse domínio). Isso é uma limitação do **meu ambiente**, não do
> projeto — no seu computador ou no build da Cloudflare (que tem acesso normal
> à internet) isso deve instalar sem problema. Se travar em algum lugar sem
> acesso à internet completo, rode `npm install --ignore-scripts` (o pacote
> não é usado em runtime, já que a transcrição roda via `onnxruntime-web` no
> navegador).

## Passo 1 — Enviar para o GitHub

```bash
cd transcrever-pt-br   # pasta deste projeto
gh repo create transcrever-pt-br --private --source=. --remote=origin
# (ou crie o repo manualmente no github.com e depois:)
git remote add origin https://github.com/SEU_USUARIO/transcrever-pt-br.git
git branch -M main
git push -u origin main
```

## Passo 2 — Conectar no Cloudflare (Workers Builds)

1. **Cloudflare Dashboard → Workers & Pages → Create → Import a repository**.
2. Selecione o repositório `transcrever-pt-br` no GitHub.
3. Configure o build:
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy -c .output/server/wrangler.json`
   - **Root directory**: (deixe em branco / raiz)
4. Não precisa adicionar nenhuma variável de ambiente — não há nenhuma usada
   no código.
5. Clique em **Save and Deploy**.

A cada `git push` na branch conectada (`main`), a Cloudflare builda e publica
de novo automaticamente — o mesmo fluxo de Workers Builds que você já usou
no NestCNC, só que aqui o "deploy command" aponta pro `wrangler.json` que o
Nitro gera dentro de `.output/server` (em vez de publicar direto a pasta
`dist` como no NestCNC).

## Testar localmente antes de publicar (opcional)

```bash
npm install
npm run build
npm run cf:preview   # roda o Worker localmente via wrangler dev
```

## Nomear/domínio

O nome do Worker é `transcrever-pt-br` (definido em `wrangler.jsonc`). Se
quiser outro nome ou já tiver esse nome ocupado na sua conta Cloudflare,
troque o campo `"name"` em `wrangler.jsonc` antes do primeiro deploy.
