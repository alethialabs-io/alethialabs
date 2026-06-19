# Демо скрипт — Trellis & Grape

**Формат:** Talking points (ключови фрази, не дословен текст)
**Общо време:** ~8 минути (в рамките на 15-минутна защита)

---

## 1. Вход (Login) — ~30 сек

- Отварям Trellis в браузъра — чист акаунт, нищо не е конфигурирано
- Dashboard е празен: няма vineyard-и, няма vine-ове, няма jobs
- "Започваме от нулата. Нов потребител, чист акаунт."

**Ключова фраза:** "Нов потребител, нищо не е конфигурирано — точно както би влязъл нов DevOps инженер."

---

## 2. Plant a Vine → нужни интеграции — ~15 сек

- Отивам на "Plant a Vine" от сайдбара
- Показвам формата — 11 секции (Network, Cluster, Database, Cache, и т.н.)
- Cloud Identity селекторът е празен — няма свързани облачни акаунти
- "Преди да конфигурираме инфраструктура, трябва да свържем облачни акаунти и Git доставчици."

**Ключова фраза:** "Формата има 11 секции — от мрежа до secrets, всичко на едно място."

---

## 3. Integrations — свързване на доставчици — ~2 мин

- Отивам на Integrations → показвам страницата с всички интеграции
- **Git доставчици:**
  - Свързвам GitHub → OAuth flow, няколко клика
  - Показвам GitLab и Bitbucket като опции
  - "Поддържаме три Git доставчика — GitHub, GitLab, Bitbucket. OAuth flow, токените се обновяват автоматично."

- **AWS:**
  - Натискам "Connect" на AWS
  - Показвам CloudFormation шаблона
  - "Потребителят деплойва CloudFormation шаблон, който създава IAM роля с External ID. Ние НИКОГА не съхраняваме AWS ключове. Tendril-ът поема ролята чрез STS AssumeRole."
  
- **GCP (кратко):**
  - "За GCP — Workload Identity Federation. Обменяме OIDC токен за временни GCP credentials."

- **Azure (кратко):**
  - "За Azure — Federated Identity. App Registration с OIDC credential."

- Показвам, че всички интеграции са "Connected" ✓

**Ключова фраза:** "Zero-credential модел — няма статични ключове. Всеки достъп е временен и отменяем."

---

## 4. Plant a Vine — конфигурация — ~2 мин

- Връщам се на Plant a Vine
- Сега Cloud Identity селекторът показва свързаните акаунти
- Попълвам:
  - **Project name:** `api-backend`
  - **Provider:** AWS (показвам Provider Ribbon-а — може да се превключи на GCP/Azure)
  - **Region:** `eu-west-1`
  - **Environment:** `production`

- **Network:** ☑ Create new VPC, CIDR: 10.0.0.0/16, Single NAT Gateway
- **Cluster:** EKS 1.31, m5.large, min 2 / desired 3 / max 10 nodes, ☑ Karpenter

- **Database:** Aurora PostgreSQL 16.4, db.r6g.large, 2 nodes, ☑ Multi-AZ
  - Показвам cost sidebar: "Виждате как разходите се обновяват в реално време"
  
- **Cache:** ElastiCache Redis, cache.r6g.large
- (Останалите секции — бързо показвам, не попълвам всичко)

- Натискам Submit → vine е създаден
- "11 секции, всяка секция създава реални Terraform ресурси. Разходите се изчисляват в реално време."

**Ключова фраза:** "Един формуляр, три облака. Превключваш Provider Ribbon-а — формата се адаптира автоматично."

---

## 5. Vine Detail → Plan → "Как се изпълнява?" — ~1 мин

- Отивам на vine detail страницата
- Показвам Infrastructure tab-а — дърво от компоненти
- Натискам "Plan" → отваря се Tendril Select Popover

- **Pause — обръщам се към комисията:**
  - "Може би се чудите — как точно се изпълнява този план? Как Terraform работи, ако ние нямаме статични ключове?"
  - "Сега ще ви покажа."

- Избирам cloud tendril → job се създава (QUEUED)

**Ключова фраза:** "Tendril-ът работи в нашия акаунт, но поема IAM роля в акаунта на потребителя. Credentials-ите са временни — 1 час, после изтичат."

---

## 6. Tendrils — обяснение и създаване — ~1.5 мин

- Отивам на Tendrils страницата
- "Tendrils са Go контейнери, работещи в ECS Fargate. Те:"
  - Полват за задачи на всеки 10 секунди
  - Изпращат heartbeat на всеки 30 секунди
  - Поемат задачи атомарно — `claim_next_job()` гарантира, че една задача не се изпълнява от два Tendril-а
  - Стриймват логове обратно в Trellis в реално време

- **Scale-to-zero:**
  - "Когато няма задачи в опашката за 5 минути, Lambda scaler мащабира ECS сервиса до 0. При нова задача — автоматично обратно на 1. Плащаме за Fargate само когато има работа."

- Създавам нов Tendril:
  - Избирам регион, CPU, памет
  - Натискам Create → DEPLOY_RUNNER job се създава
  - "Ще отнеме около 2 минути. Tendril-ът ще се появи тук със статус ONLINE."

- Показвам статус: зелена точка = ONLINE, жълта = DRAINING, червена = OFFLINE

**Ключова фраза:** "Tendril-ът е безсървърен контейнер. Не инсталирате нищо — нито Terraform, нито kubectl, нито Helm. Scale-to-zero за минимални разходи."

---

## 7. Обратно → план + разходи — ~30 сек

- Връщам се към vine detail
- Показвам завършения план:
  - Terraform resource tree — колко ресурси ще се създадат
  - Cost breakdown — колко ще струва на месец
- "Преди да приложим, виждаме точно какво ще се създаде и колко ще струва."
- Натискам Apply → DEPLOY job се създава

**Ключова фраза:** "Plan-review-apply. Нищо не се провизира без изричен Apply."

---

## 8. Job статуси и логове — ~30 сек

- Отивам на Jobs страницата
- Показвам списъка с jobs:
  - PLAN → SUCCESS (завършен)
  - DEPLOY → PROCESSING (в момента)
  - DEPLOY_RUNNER → SUCCESS (tendril-ът е готов)
- Отварям DEPLOY job-а → показвам real-time логове
- "Terraform stdout и stderr се стриймват чрез Supabase Realtime WebSocket директно в браузъра."
- "И Grape, и Tendril се версионират чрез release-please с conventional commits — автоматични CHANGELOG-ове и GitHub Releases."

**Ключова фраза:** "Всяка стъпка е проследима. Всяко действие е логнато."

---

## 9. Pre-provisioned cluster — ~30 сек

- Отивам на Clusters страницата
- "Пълното провизиране на EKS клъстер отнема около 20 минути. Затова подготвих един предварително."
- Показвам ClusterCard:
  - Cluster name, endpoint, region
  - ArgoCD URL
  - kubeconfig download
- "ArgoCD е инсталиран автоматично. Git е source of truth. Оттук нататък — GitOps."

**Ключова фраза:** "От нулата до production EKS за 20 минути. С ArgoCD, готов за GitOps от първия ден."

---

## Край на демото → обратно към слайдовете

- "Нека се върнем към слайдовете за обобщение."
- Превключвам обратно на presentation.html → slide 7 (Резултати)

---

## Timing overview

| Стъпка | Време | Кумулативно |
|--------|-------|-------------|
| Вход | 0:30 | 0:30 |
| Plant a Vine → нужни интеграции | 0:15 | 0:45 |
| Integrations | 2:00 | 2:45 |
| Plant a Vine — конфигурация | 2:00 | 4:45 |
| Vine Detail → Plan | 1:00 | 5:45 |
| Tendrils | 1:30 | 7:15 |
| План + разходи + Apply | 0:30 | 7:45 |
| Job статуси | 0:30 | 8:15 |
| Pre-provisioned cluster | 0:30 | 8:45 |

**Общо демо: ~8:45 мин** (оставя ~6 мин за слайдове)
