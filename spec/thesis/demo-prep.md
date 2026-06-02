# Подготовка за демото — Trellis & Grape

Този файл е за четене преди защитата. Не е скрипт за четене на глас — целта е да си напълно подготвен какво показваш, защо го показваш, и какво да кажеш ако те питат нещо по-дълбоко.

---

## Преди демото: какво трябва да е готово

- [ ] Чист акаунт в Trellis (или изтрий всички vineyards/vines от съществуващ)
- [ ] AWS акаунт с CloudFormation template вече деплойнат (GrapeProvisionerRole)
- [ ] GCP проект с WIF конфигуриран
- [ ] Azure subscription с App Registration
- [ ] GitHub OAuth app конфигуриран
- [ ] Един предварително провизиран EKS клъстер (отнема ~20 мин, направи го преди)
- [ ] Worker вече деплойнат и ONLINE (за plan/apply по време на демото)
- [ ] Браузър отворен на Trellis login страницата
- [ ] Интернет връзка (OAuth flows изискват network)

---

## Стъпка 1: Вход (Login) — ~30 сек

### Какво показваш
Отваряш Trellis в браузъра. Влизаш с нов/чист акаунт. Dashboard е празен.

### Какво казваш
"Започваме от нулата. Нов потребител, чист акаунт — нищо не е конфигурирано. Нито vineyard-и, нито vine-ове, нито jobs."

### Ако те питат: Как работи автентикацията?
Supabase GoTrue. Поддържаме OAuth чрез GitHub, GitLab, Bitbucket и Google. Потребителят натиска бутон, redirect към provider-а, callback с код, Supabase създава сесия с JWT. Row Level Security в PostgreSQL гарантира, че всеки потребител вижда само своите данни — дори raw SQL заявка `SELECT * FROM vines` връща само неговите записи, защото RLS политиката филтрира по `auth.uid()`.

За CLI-то: RFC 8628 Device Authorization Grant. CLI генерира device_code, потребителят отваря URL в браузър и потвърждава. CLI получава refresh_token, криптиран локално в `~/.config/grape/auth.json`. Никога не въвеждаш парола в терминала.

---

## Стъпка 2: Plant a Vine → нужни интеграции — ~15 сек

### Какво показваш
Натискаш "Plant a Vine" от сайдбара. Формата се зарежда с 11 секции. Cloud Identity селекторът е празен — няма свързани облачни акаунти.

### Какво казваш
"Преди да конфигурираме инфраструктура, трябва да свържем облачни акаунти и Git доставчици. Нека отидем на Integrations."

### Защо е важно
Показваш, че системата не работи с "магически" hardcoded credentials. Потребителят трябва изрично да свърже акаунтите си. Това е BYOC (Bring Your Own Cloud) моделът.

---

## Стъпка 3: Integrations — свързване на доставчици — ~2 мин

### Какво показваш
Integrations страницата. Свързваш GitHub, после AWS, после кратко споменаваш GCP/Azure.

### Git доставчици (GitHub)

**Какво правиш:** Натискаш "Connect" на GitHub → OAuth flow → няколко клика → Connected ✓

**Какво казваш:** "Поддържаме три Git доставчика — GitHub, GitLab, Bitbucket. OAuth flow, потребителят дава достъп, ние получаваме access token. Токените се обновяват автоматично чрез refresh flow."

**Ако те питат: Как съхранявате Git токените?**
Таблица `provider_tokens` в Supabase. Когато потребител се автентикира с GitHub/GitLab/Bitbucket, Supabase записва identity-то в `auth.identities`. Ние имаме database trigger, който копира access_token и refresh_token в `provider_tokens`. Когато токенът изтече, `getValidProviderToken()` server action-ът проверява expiry, прави refresh call към provider API-то, и обновява токена. Всичко е encrypted at rest в Supabase.

### AWS

**Какво правиш:** Натискаш "Connect" на AWS → показваш CloudFormation шаблона → обясняваш какво прави.

**Какво казваш:** "AWS връзката работи по следния начин: потребителят деплойва CloudFormation шаблон в своя AWS акаунт. Шаблонът създава IAM роля — `GrapeProvisionerRole` — с External ID. Ние НИКОГА не съхраняваме AWS Access Keys. Когато Worker трябва да провизира нещо, той извиква `STS AssumeRole` с External ID-то и получава временни credentials — валидни само 1 час."

**Ако те питат: Какво е External ID и защо е нужен?**
External ID е допълнителен идентификатор, който предотвратява "confused deputy" атаки. Без External ID, ако някой знае ARN-а на ролята, може да я поеме от друг AWS акаунт. С External ID, само нашата платформа (която знае ID-то) може да извика AssumeRole. Стойността се генерира от Trellis и се записва в `cloud_identities` таблицата. CloudFormation шаблонът включва и trust policy, която ограничава кой може да поеме ролята — само нашият Worker акаунт.

**Ако те питат: Какви permissions има ролята?**
Ролята има permissions за: EC2 (VPC, subnets, NAT gateways, security groups), EKS (clusters, node groups, OIDC providers), RDS (Aurora clusters, instances), ElastiCache, Route53, Secrets Manager, DynamoDB, SQS/SNS, ECR, S3, IAM (за IRSA — IAM Roles for Service Accounts). Всичко е scoped с conditions — ролята не е admin, а има точно permissions-ите нужни за Terraform.

### GCP (кратко)

**Какво казваш:** "За GCP използваме Workload Identity Federation. Потребителят конфигурира WIF pool в своя GCP проект. Нашият Worker представя OIDC токен, GCP го валидира и издава временни credentials. Няма service account JSON ключове."

**Ако те питат: Какво е Workload Identity Federation?**
WIF позволява external identity providers (в нашия случай — Trellis/Supabase) да се автентикират в GCP без service account ключове. Потребителят създава Workload Identity Pool и Provider в GCP конзолата. Конфигурира се OIDC issuer URL и audience. Когато Worker трябва достъп, той извиква `STS:ExchangeToken` с OIDC токен от Trellis, GCP го валидира и връща short-lived access token. Няма файлове, няма ключове, няма какво да leak-не.

### Azure (кратко)

**Какво казваш:** "За Azure — Federated Identity. Потребителят създава App Registration с federated credential. OIDC автентикация, без client secrets."

**Ако те питат: Как работи Azure Federated Identity?**
Потребителят създава App Registration в Azure AD (сега Entra ID). Добавя Federated Credential с issuer URL (Trellis) и subject claim. Когато Worker трябва достъп, той представя OIDC токен, Azure го валидира срещу registered issuer/subject, и издава access token. Никога не се генерира client secret. Ако потребителят иска да отнеме достъпа — просто трие App Registration-а.

### Обща ключова фраза
"Zero-credential модел. Три различни облака, три различни механизма, един общ принцип — никога не съхраняваме статични ключове. Всеки достъп е временен и отменяем."

---

## Стъпка 4: Plant a Vine — конфигурация — ~2 мин

### Какво показваш
Връщаш се на Plant a Vine. Попълваш формата за AWS production клъстер.

### Какво попълваш (бързо, не се бави)
1. **Project Basics:** `api-backend`, AWS, `eu-west-1`, production
2. **Network:** ☑ Create new VPC, CIDR 10.0.0.0/16, ☑ Single NAT Gateway
3. **Cluster:** EKS 1.31, m5.large, min 2 / desired 3 / max 10, ☑ Karpenter
4. **Database:** Aurora PostgreSQL 16.4, db.r6g.large, 2 nodes, ☑ Multi-AZ
5. **Cache:** ElastiCache Redis, cache.r6g.large
6. Покажи cost sidebar — "Виждате как разходите се обновяват в реално време"
7. Submit

### Какво казваш
"Формата има 11 секции — мрежа, клъстер, бази данни, кеш, NoSQL, messaging, DNS, secrets, container registry и repositories. Всяка секция съответства на реален Terraform ресурс. Забележете cost sidebar-а — разходите се изчисляват в реално време, преди да деплойнем каквото и да е."

Покажи Provider Ribbon-а: "Мога да превключа между AWS, GCP и Azure. Формата се адаптира — EKS става GKE, Aurora става Cloud SQL, ElastiCache става Memorystore. Един формуляр, три облака."

### Ако те питат: Как се изчисляват разходите?
Cost sidebar-ът fetch-ва pricing data от AWS Pricing API за конкретния регион. Всяка секция (cluster, database, cache) има pricing formula. При промяна на instance type или node count, sidebar-ът преизчислява и показва estimated monthly cost. За по-детайлен анализ имаме Infracost интеграция — тя анализира Terraform plan-а и дава точна разбивка.

### Ако те питат: Какво се случва при Submit?
1. Създава се `vines` ред в базата данни със статус `DRAFT`
2. Създават се child rows в component таблиците: `vine_network`, `vine_cluster`, `vine_database`, `vine_caches`, etc.
3. Vine-ът е готов за Plan/Apply
4. Нормализираната schema позволява всеки компонент да има собствен статус и cost estimate

### Ако те питат: Защо Vine и Vineyard? Какъв е домейнът?
Viticulture (лозарство) тема: Trellis = опора (web), Grape = грозде (CLI), Vineyard = лозе (workspace/project), Vine = лоза (infrastructure configuration), Harvest = бране (deployment). Не е просто маркетинг — помага за запомняне на компонентите.

---

## Стъпка 5: Vine Detail → Plan → "Как се изпълнява?" — ~1 мин

### Какво показваш
Отиваш на vine detail страницата. Показваш Infrastructure tab-а. Натискаш Plan → отваря се Worker Select Popover.

### Какво казваш
"Сега имаме конфигурация. Натискам Plan — и тук се отваря worker selector. Може да си зададете въпроса — как точно работи това? Кой изпълнява Terraform? Ако нямаме статични ключове, как достъпваме AWS акаунта на потребителя?"

**Pause — обръщаш се към комисията:**
"Сега ще покажа."

Избираш cloud worker → job се създава (QUEUED).

### Ако те питат: Какво е Worker Select Popover?
Компонент, който показва всички регистрирани Workers и техния статус (ONLINE/OFFLINE/DRAINING). Потребителят избира кой Worker да изпълни задачата, или "Any available" за автоматичен избор. Зеленото кръгче = heartbeat получен в последните 60 секунди.

---

## Стъпка 6: Workers — обяснение и създаване — ~1.5 мин

### Какво показваш
Отиваш на Workers страницата. Обясняваш какво е Worker. Създаваш нов Worker.

### Какво казваш
"Workers са Go контейнери, работещи в ECS Fargate — Amazon's serverless container service. Worker-ът е нашият execution engine."

"Ето какво прави Worker-ът:
- На всеки 10 секунди poll-ва за задачи чрез POST /api/jobs/claim
- Поемането е атомарно — функцията claim_next_job() в PostgreSQL гарантира, че една задача не се изпълнява от два Worker-а
- На всеки 30 секунди изпраща heartbeat — ако го пропусне, Trellis го маркира OFFLINE и requeue-ва задачите му
- Когато получи задача, чете cloud_identity от конфигурацията и поема IAM роля (или WIF/Federated Identity)
- Изпълнява Terraform init → plan → apply в контекста на клиентския акаунт
- Стриймва stdout и stderr обратно в Trellis чрез Supabase Realtime WebSocket"

Показваш "Add Worker" → избираш регион, CPU, memory → Create.

"Сега се създава DEPLOY_WORKER job. Worker infrastructure-та се провизира автоматично — ECS task definition, ECR image, IAM roles, CloudWatch log group. След около 2 минути ще видим нов Worker със статус ONLINE."

### Ако те питат: Защо ECS Fargate?
Fargate е serverless — не управляваме EC2 instances. Плащаме само когато Worker работи. Scaling е автоматичен. Не трябва да пачваме OS или runtime. Worker-ът е Docker image с Go binary + Terraform binary + kubectl + Helm — всичко embedded.

### Ако те питат: Какво е claim_next_job()?
PostgreSQL function, която атомарно:
1. Взема следващата QUEUED задача (ORDER BY created_at ASC)
2. Маркира я PROCESSING
3. Записва worker_id
4. Връща задачата на Worker-а

Всичко е в една транзакция. Ако два Worker-а poll-нат едновременно, само единият получава задачата. Няма race condition, няма дублиране.

### Ако те питат: Как работи heartbeat?
Worker изпраща POST /api/workers/heartbeat на всеки 30 секунди. Trellis записва timestamp-а. Ако timestamp-ът е по-стар от 60 секунди, Worker-ът се маркира OFFLINE. Ако Worker умре по средата на задача, Trellis requeue-ва задачата и друг Worker може да я поеме. Това е graceful recovery — без manual intervention.

### Ако те питат: Self-hosted vs Cloud-hosted?
Два режима:
- **Cloud-hosted:** Platform-ът деплойва Worker в Fargate. Потребителят не инсталира нищо.
- **Self-hosted:** Потребителят пуска `grape worker start` на своя машина или в свой клъстер. Worker-ът е същият Go binary, но работи в инфраструктурата на потребителя. Полезно за on-prem или air-gapped environments.

---

## Стъпка 7: Обратно → план + разходи — ~30 сек

### Какво показваш
Връщаш се на vine detail. Plan job-ът е завършен. Показваш:
- Terraform resource tree (какво ще се създаде)
- Cost breakdown (колко ще струва)

Натискаш Apply.

### Какво казваш
"Планът е готов. Виждаме 47 ресурса за създаване — VPC, subnets, NAT gateway, EKS cluster, node group, Aurora cluster, ElastiCache, Route53 записи, Secrets Manager, ECR. Estimated monthly cost: $847."

"Важно: нищо не се провизира без изричен Apply. Plan-Review-Apply workflow — потребителят преглежда какво точно ще се създаде и колко ще струва, преди да потвърди."

Натискаш Apply → DEPLOY job се създава.

### Ако те питат: Какво точно е Plan?
Worker изпълнява `terraform plan` с конфигурацията от vine-а. Генерира `.tfplan` файл. После `terraform show -json` за structured output. Ако има Infracost token — пуска Infracost analysis на plan JSON-а за cost breakdown. Plan artifact се записва в Supabase S3 bucket.

### Ако те питат: Къде се пази Terraform state?
Supabase S3 backend. Path structure: `{vineyard}/{project}/{stage}/{region}/terraform.tfstate`. Всеки vine има собствен state файл. Backend config-ът се генерира динамично от Worker-а преди `terraform init`.

---

## Стъпка 8: Job статуси и логове — ~30 сек

### Какво показваш
Отиваш на Jobs страницата. Показваш списъка с jobs:
- PLAN → SUCCESS
- DEPLOY → PROCESSING (ако все още работи)
- DEPLOY_WORKER → SUCCESS

Отваряш DEPLOY job-а → показваш real-time логове.

### Какво казваш
"Всяка операция е job в опашката. Виждаме статусите — QUEUED означава чака Worker, PROCESSING означава Worker работи по нея, SUCCESS/FAILED е крайният резултат."

"Логовете се стриймват в реално време. Worker пише Terraform output в batch-ове, POST-ва ги на /api/jobs/{id}/logs, и Supabase Realtime ги push-ва на клиента чрез WebSocket. Виждаме точно какво прави Terraform в момента."

### Ако те питат: Как работи log streaming?
Worker има `LogStreamer` — Go struct, който буферира stdout/stderr и ги flush-ва на всеки 500ms като batch POST към Trellis API. Trellis записва в `job_logs` таблицата. Клиентът е subscribed чрез Supabase Realtime на INSERT events в тази таблица. Всеки нов batch се появява в UI-то веднага.

### Ако те питат: Какви типове jobs има?
- `CONNECTION_TEST` — верифицира, че cloud credentials работят
- `FETCH_RESOURCES` — discovery на съществуващи ресурси (VPCs, subnets, hosted zones)
- `PLAN` — Terraform plan + optional Infracost
- `DEPLOY` — Terraform apply + ArgoCD install
- `DESTROY` — Terraform destroy (с graceful cleanup)
- `DEPLOY_WORKER` — провизиране на Worker infrastructure
- `DESTROY_WORKER` — премахване на Worker infrastructure

---

## Стъпка 9: Pre-provisioned cluster — ~30 сек

### Какво показваш
Отиваш на Clusters страницата. Показваш предварително провизиран EKS клъстер.

### Какво казваш
"Пълното провизиране отнема около 20 минути — VPC, EKS, databases, ArgoCD. Затова подготвих един предварително. Ето го."

Показваш:
- Cluster name, endpoint, region
- ArgoCD URL (ако е достъпен)
- Provider icon (AWS)

"ArgoCD е инсталиран автоматично при deploy. Git е source of truth. Оттук нататък — всяка промяна в Git repo-то се прилага автоматично от ArgoCD."

### Ако те питат: Как се инсталира ArgoCD?
След успешен `terraform apply`, Worker-ът:
1. Извлича cluster name и endpoint от Terraform outputs
2. Генерира kubeconfig чрез AWS EKS API (или gcloud/az за GCP/Azure)
3. Инсталира ArgoCD чрез Helm chart (`helm_release.argocd`)
4. Чака ArgoCD pods да станат Ready
5. Извлича ArgoCD admin password
6. Рендерира ArgoCD Application manifests (App of Apps pattern)
7. Apply-ва ги в клъстера
8. Записва ArgoCD URL и credentials в job metadata

### Ако те питат: Какво е App of Apps?
ArgoCD pattern: едно "parent" Application сочи към директория с YAML файлове, всеки от които е отделно Application. Когато добавиш нов YAML файл в директорията, ArgoCD автоматично го deploy-ва. Нашият parent сочи към `manifests/applications/` в infra repo-то. Terraform outputs (cluster name, VPC ID, RDS endpoint) се инжектират като Helm values чрез "Infra Facts" YAML файл.

---

## Край на демото

### Какво казваш
"Нека се върнем към слайдовете за обобщение."

Превключваш обратно на presentation.html → slide 7 (Резултати).

---

## Общи въпроси от комисията

### Защо Go за CLI-то, а не Python/Node/Rust?
- **Single binary** — без runtime dependencies (Python има venv, Node има node_modules)
- **Cross-platform** — един `go build` за macOS/Linux/Windows
- **Concurrency** — goroutines за паралелен streaming на логове
- **Ecosystem** — Cobra (CLI framework), Charmbracelet (TUI), AWS SDK v2
- **Embedded files** — `go embed` позволява Terraform templates да са вътре в binary-то

### Защо Supabase, а не custom backend?
- **PostgreSQL + RLS** — сигурност на database layer, не на application layer
- **Realtime** — WebSocket subscriptions за лог streaming, job status updates
- **Auth** — GoTrue с multi-provider OAuth, без custom auth code
- **S3** — Terraform state storage без допълнителен AWS S3 bucket
- **Speed** — от нулата до production за часове, не седмици

### Защо не ползвате Terraform Cloud / Spacelift / Pulumi?
- **Те изискват credentials** — ние не ги съхраняваме
- **Те нямат visual form** — пишеш HCL/code, не конфигурираш визуално
- **Те не bootstrapват GitOps** — ArgoCD е add-on, не default
- **Ние генерираме Terraform** — потребителят притежава output-а, не е locked-in

### Как се гарантира, че два Worker-а не изпълняват една задача?
PostgreSQL `claim_next_job()` функция. Използва `FOR UPDATE SKIP LOCKED` — row-level lock, който е невидим за другите транзакции. Атомарно: SELECT + UPDATE в една транзакция. Ако Worker-ът crash-не, lock-ът се освобождава автоматично.

### Какво се случва ако Worker умре по средата на deploy?
1. Heartbeat спира да идва
2. Trellis маркира Worker-а OFFLINE след 60 секунди
3. Job-ът остава PROCESSING, но stale (no log updates)
4. Stale job recovery: Trellis детектира job без лог updates > 5 минути, маркира го FAILED
5. Потребителят може да retry-не ръчно
6. Terraform state е в S3 — следващият run продължава от там, не от нулата

### Мултитенантност?
Row Level Security в PostgreSQL. Всяка таблица има RLS policy: `auth.uid() = user_id`. Дори ако има bug в application code-а, PostgreSQL ще откаже да покаже данни на грешен потребител. Cloud identities се филтрират допълнително по `provider` — AWS identity няма да се покаже в GCP контекст.
