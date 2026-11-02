# Relatório — Persistência distribuída PostgreSQL + MongoDB

## Arquitetura

O sistema tem um front-end de observabilidade, uma API Node.js (o coordenador) e dois participantes: PostgreSQL e MongoDB. O coordenador registra cada fase no `operation_log` do PostgreSQL. O painel faz leitura dos dois participantes a cada **10 ms** e exibe uma trilha em tempo real: durante `PREPARING`, ela mostra a inserção dentro da transação, enquanto as tabelas continuam sem o dado por causa do isolamento transacional.

```
Browser ──HTTP──> Coordenador Node.js ──> PostgreSQL (customers + operation_log)
                         └─────────────> MongoDB (customers)
```

Como PostgreSQL e MongoDB não oferecem um único protocolo XA/2PC compartilhado, o projeto implementa **2PC no nível da aplicação**. Em cada participante há uma transação local aberta durante a fase `PREPARE`; diante de uma falha induzida, ela é abortada com `ROLLBACK` (PostgreSQL) ou `abortTransaction()` (MongoDB). Para atualizações já confirmadas por um participante, há compensação protegida por versão. Isto evita prometer atomicidade global inexistente; para produção, a mesma abordagem deve incluir uma outbox durável, idempotência e um reconciliador.

## Cenários executados

| Cenário | Sequência | Falha induzida | Resultado esperado |
|---|---|---|---|
| 1 | PostgreSQL → MongoDB | gravação MongoDB | O registro recém-criado é removido do PostgreSQL; operação `ABORTED`. |
| 2 | MongoDB → PostgreSQL | gravação PostgreSQL | O documento recém-criado é removido do MongoDB; operação `ABORTED`. |
| 3 | Atualização concorrente | nenhuma | PostgreSQL e MongoDB passam para o mesmo status/versão; operação `COMMITTED`. |

No cenário 3, o intervalo artificial de 80 ms torna observável, pelo leitor de 10 ms, a janela de consistência eventual entre os dois commits. O bloqueio otimista (`version`) evita sobrescrever uma atualização concorrente. Caso o MongoDB não confirme, a atualização já realizada no PostgreSQL é compensada.

## Como executar

Pré-requisitos: Docker Desktop e Node.js 20+.

```powershell
Copy-Item .env.example .env
docker compose up -d
npm install
npm run dev
```

O Node.js é executado no Windows; por isso, mantenha `MONGO_URL` apontando para
`localhost`, e não para `mongo` (nome acessível apenas entre contêineres).

Abra `http://localhost:3000`. Os botões dos dois primeiros cartões executam falhas controladas. O terceiro alterna o status de um cliente criado automaticamente e o painel atualiza continuamente.

Para encerrar a infraestrutura:

```powershell
docker compose down
```
