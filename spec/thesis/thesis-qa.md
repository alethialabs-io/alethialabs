# Въпроси и отговори за защита на дипломна работа

---

## 1. Защо е избран Go за реализацията на платформата?

Go е избран за CLI инструмента (Grape) и провизиониращия работник (Tendril) по няколко ключови причини:

**Конкурентност.** Go предлага горутини (goroutines) и канали (channels) като вградени примитиви. Tendril работникът използва конкурентни горутини за polling на задачи, heartbeat цикъл и асинхронно изпращане на логове — всичко с чист, линеен код без callback hell или promise вериги. Например в `tendril/runner/tendril.go` две горутини вървят паралелно — една за heartbeat, друга за основния poll цикъл — координирани чрез `context.Context` и канали за сигнали.

**Кроскомпилация и дистрибуция.** С една команда Go компилира статични бинарни файлове за Linux и macOS (amd64/arm64) без външни зависимости (`CGO_ENABLED=0`). GoReleaser (`.goreleaser.yml`) автоматизира билдване за 4 платформи и публикуване в Homebrew. Резултатният бинарен файл е ~8-15MB и не изисква runtime среда — за разлика от Node.js или Python, където потребителят трябва да инсталира интерпретатор.

**Go embed за шаблони.** Чрез `//go:embed` директивата (`packages/grape-core/assets/embed.go`) Terraform шаблоните и Helm чартовете се вграждат директно в бинарния файл. Това елиминира нуждата от външен файлов достъп по време на изпълнение — един файл съдържа всичко необходимо за провизиониране.

**TUI екосистема.** Charmbracelet библиотеките (Bubble Tea, Lipgloss, Huh) са специално създадени за Go и предлагат интерактивни терминални интерфейси — таблици с навигация, спинери, формуляри за избор — с минимален overhead.

**Docker ефективност.** Multi-stage Docker билдовете произвеждат Alpine-базирани образи с малък Go бинарен файл. Самият Tendril образ добавя Terraform, AWS CLI и kubectl, но Go частта е пренебрежимо малка.

---

## 2. Каква е ролята на Supabase в архитектурата на системата?

Supabase изпълнява ролята на **Backend-as-a-Service (BaaS)** слой, предоставящ четири основни услуги:

**PostgreSQL база данни.** Цялото състояние на платформата се съхранява в Supabase PostgreSQL — потребителски профили (`profiles`), облачни идентичности (`cloud_identities`), инфраструктурни конфигурации (`vines`, `vine_cluster`, `vine_database` и др.), задачи за провизиониране (`provision_jobs`), логове (`job_logs`) и работници (`runners`). Типовете се генерират автоматично в `types/database.types.ts`.

**Автентикация.** Supabase Auth управлява OAuth потоците за GitHub, GitLab, Bitbucket и Google чрез `signInWithOAuth()`. За CLI инструмента е имплементиран Device Code Flow — Grape генерира код чрез API, потребителят го потвърждава в браузъра, и CLI получава JWT токен чрез `/api/auth/cli/exchange`.

**Row Level Security (RLS).** Всяка таблица има RLS политики, които ограничават достъпа до записите на автентикирания потребител (`auth.uid() = user_id`). Това означава, че дори при компрометиран клиент, потребител не може да види чужди ресурси.

**Realtime.** Supabase Realtime осигурява WebSocket-базирано излъчване на промени в базата данни. Таблиците `job_logs`, `provision_jobs`, `runners` и `vine_cluster` са добавени към `supabase_realtime` публикацията. Уеб интерфейсът се абонира за `postgres_changes` събития и получава актуализации в реално време.

**Важно архитектурно решение:** CLI (Grape) и работникът (Tendril) **не комуникират директно** със Supabase. Те използват REST API на Trellis (Next.js), който от своя страна взаимодейства със Supabase чрез service role клиент. Това осигурява единна точка за оторизация и валидация.

---

## 3. Как работи механизмът за логове в реално време?

Механизмът за стрийминг на логове преминава през 5 етапа:

**Етап 1 — Работникът буферира логове.** Когато Tendril изпълнява Terraform операция, stdout и stderr се прихващат от два `JobLogger` инстанса (`tendril/runner/logger.go`). Всеки логер буферира текст и го изпраща на порции — или при достигане на 10KB, или на всеки 2 секунди (което от двете настъпи първо).

**Етап 2 — HTTP POST към API.** `JobLogger.Flush()` извиква `RunnerAPIClient.SendLog()`, който прави POST заявка към `/api/jobs/{id}/logs` с полета `log_chunk` и `stream_type` (STDOUT/STDERR). Заявката се автентикира с `X-Runner-ID` и `X-Runner-Token` хедъри.

**Етап 3 — Запис в базата данни.** API маршрутът (`trellis/app/api/jobs/[id]/logs/route.ts`) валидира работника и извиква Supabase RPC функцията `insert_job_log()`. Тази функция е `SECURITY DEFINER` — верифицира собствеността на задачата и атомарно записва лога в таблицата `job_logs`.

**Етап 4 — Realtime излъчване.** Тъй като `job_logs` е добавена към `supabase_realtime` публикацията (`ALTER PUBLICATION supabase_realtime ADD TABLE public.job_logs`), всеки INSERT автоматично се излъчва като WebSocket събитие до абонираните клиенти.

**Етап 5 — Консумация от клиентите:**

- **Уеб интерфейс (Trellis):** Страницата на задачата (`dashboard/jobs/[id]/page.tsx`) се абонира за Supabase канал `job_logs:{jobId}` с филтър `job_id=eq.${jobId}`. При всеки INSERT събитие, новият лог се добавя към React state и терминалът автоматично скролва надолу.

- **CLI (Grape):** Командата `grape jobs logs --follow` (`cmd/jobs_logs.go`) използва polling на всеки 2 секунди чрез `GET /api/cli/jobs/{id}/logs?after={lastID}`. Параметърът `after` предотвратява дублиране на логове. CLI оцветява STDERR в червено и SYSTEM съобщенията в сиво.

### Диаграма на потока

```
Tendril (Go)          Trellis (Next.js)         Supabase            Клиенти
─────────────         ─────────────────         ────────            ───────
JobLogger.Write()
    │ буфер 10KB / 2s
    ▼
SendLog() ──POST──→ /api/jobs/{id}/logs
                         │
                         ▼
                    insert_job_log() ──INSERT──→ job_logs
                                                    │
                                        ┌───────────┴───────────┐
                                        ▼                       ▼
                                   WebSocket              HTTP GET poll
                                   (Realtime)             (CLI, 2s)
                                        │                       │
                                        ▼                       ▼
                                   Trellis UI              Grape CLI
                                   (браузър)              (терминал)
```
