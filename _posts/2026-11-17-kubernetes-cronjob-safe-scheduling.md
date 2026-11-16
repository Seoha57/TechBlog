---
layout: post
title: "Kubernetes CronJob을 안전하게 운영하는 법: 일정·중복 실행·실패 복구·정리 기준"
categories: [Infrastructure]
tags: [infrastructure, kubernetes, cronjob, job, scheduling, reliability]
description: "Kubernetes CronJob의 일정과 Job 생성 방식, concurrencyPolicy·startingDeadlineSeconds·재시도·이력 정리 원칙을 업무 예시와 함께 설명합니다."
---

## 먼저 답하기

### Q. CronJob은 리눅스 crontab을 Kubernetes에 옮긴 것인가요?

A. 비슷한 cron 식을 쓰지만 운영 모델은 다르다. Kubernetes CronJob은 정해진 시각에 Job 객체를 만들고, Job controller가 Pod를 실행해 완료를 관리한다. 즉 CronJob 하나가 container를 계속 실행하는 것이 아니라, 스케줄러 역할의 controller와 실행 단위 Job, 실제 프로세스 Pod가 나뉜다. 이 차이를 이해하지 않으면 중복 실행, 누락된 일정, 오래 남은 Job, 재시도 폭주를 단순한 cron 설정 문제로 오해하기 쉽다.

### Q. 매일 한 번 실행할 작업이면 CronJob 설정만 하면 안전한가요?

A. 아니다. 작업이 두 번 실행돼도 되는지, 이전 실행이 끝나지 않았을 때 무엇을 할지, controller가 잠시 멈췄다가 돌아오면 밀린 실행을 어떻게 다룰지, 실패한 Job의 로그와 이력을 얼마나 남길지까지 결정해야 한다. 특히 결제 정산, 이메일 발송, 데이터 삭제, 외부 API 호출처럼 부작용이 있는 일은 CronJob의 중복 방지뿐 아니라 애플리케이션의 멱등성(idempotency)과 업무 키 검증이 필요하다.

## 먼저 알아둘 기반 기술

### CronJob, Job, Pod의 역할

CronJob은 반복 일정의 선언이다. `schedule`에 cron 표현식을 적으면 CronJob controller가 시간이 되었을 때 Job을 생성한다. Job은 "성공적으로 끝날 Pod를 하나 이상 확보한다"는 목표를 가진 workload이고, Pod는 실제 image와 command를 실행한다. 따라서 실패를 볼 때는 CronJob의 마지막 스케줄 시각, 생성된 Job의 상태, Job이 만든 Pod의 exit code·log를 순서대로 살펴야 한다.

이 구조 덕분에 동일한 container command를 one-off Job으로도, CronJob으로도 사용할 수 있다. 반대로 Deployment에 배치 작업 command를 넣어 replicas를 0과 1로 바꾸는 방식은 실행 이력·완료 조건·재시도 의미가 흐려질 수 있다. 반복적인 유한 작업은 Job 계열 리소스로 표현하는 편이 Kubernetes의 controller 모델과 맞는다.

### cron 표현식과 시간대

cron 표현식은 분·시·일·월·요일 같은 필드를 써서 실행 시각을 표현한다. `0 2 * * *`는 보통 매일 02:00을 뜻하지만, "02:00이 어느 시간대인가"는 별도 문제다. Kubernetes CronJob은 버전과 설정에 따라 time zone field를 지원하며, cluster controller manager의 시간대와 사람이 기대하는 업무 시간대가 다를 수 있다. 해외 사용자, 서머타임, 한국 본사와 해외 리전이 함께 있는 서비스라면 `Asia/Seoul` 같은 IANA time zone을 명시하고, 실제 다음 실행 시각을 검증해야 한다.

시간대는 단순한 표시 문제도 아니다. 월말 정산이 현지 날짜 기준인지 UTC 기준인지에 따라 같은 cron 식이 다른 데이터 범위를 처리할 수 있다. job 내부 SQL이나 API 요청에 날짜를 계산하는 코드가 있다면 CronJob의 schedule time, container OS time zone, database session time zone을 함께 문서화한다. cron이 제때 실행됐는데 결과 날짜가 하루 어긋나는 문제는 대개 이 경계에서 생긴다.

### controller의 대략적인 스케줄링

CronJob은 정확히 원자시계처럼 매 초 정각에 실행을 보장하는 장치가 아니다. controller의 동작, API server 상태, leader election, cluster 부하에 따라 Job 생성은 지연될 수 있다. Kubernetes 공식 문서도 CronJob scheduling은 대략적인 실행을 전제로 보며, 작업은 멱등적으로 설계할 것을 권한다. 따라서 "새벽 2시에 반드시 한 번만 실행"이 법적·금전적으로 엄격한 요구라면, CronJob 하나에 모든 보장을 기대하지 말고 업무 ledger, 실행 키, 재조정 절차를 별도로 둬야 한다.

## 가장 중요한 설정: 이전 실행과 새 실행이 만날 때

### concurrencyPolicy

`concurrencyPolicy`는 이전 Job이 아직 실행 중일 때 새 스케줄 시각이 오면 무엇을 할지 정한다. 대표 값은 `Allow`, `Forbid`, `Replace`다.

| 값 | 동작 | 적합한 예 | 주의점 |
| --- | --- | --- | --- |
| Allow | 이전과 새 Job을 함께 실행 | 독립적인 캐시 warm-up | 동일 데이터 중복 처리 가능 |
| Forbid | 이전 Job이 있으면 새 실행을 건너뜀 | 하루 한 번 전체 집계 | 실행 누락을 별도로 감시해야 함 |
| Replace | 이전 Job을 종료하고 새 Job을 시작 | 최신 상태만 필요한 동기화 | 종료가 즉시 완료된다고 가정하면 안 됨 |

`Forbid`가 중복을 완전히 막는다고 오해하면 안 된다. controller가 Job을 만들기 전후의 장애, 수동 Job 실행, 배포 도구의 중복 apply, application 내부 retry는 별도로 존재한다. 또한 이전 Job이 느려져 다음 실행을 계속 건너뛰면 작업이 쌓이지 않고 조용히 누락될 수 있다. "중복보다 누락이 낫다"는 업무 판단이 있는 경우에만 Forbid가 맞다.

`Replace`는 오래된 작업을 중단하고 최신 작업을 우선하고 싶을 때 유용해 보이지만, 실행 중이던 Pod가 외부 API에 요청을 보낸 뒤 종료될 수 있다. 예를 들어 전체 데이터를 읽어 검색 색인을 갱신하는 job은 최신 실행이 이전 실행의 중간 결과를 덮어쓸 수 있다. replace를 쓰려면 중단 가능한 단위, checkpoint, 원자적 publish, cleanup 동작을 application 수준에서 설계해야 한다.

### startingDeadlineSeconds

controller가 예정 시각을 놓쳤을 때 얼마나 늦은 실행까지 허용할지를 `startingDeadlineSeconds`로 정할 수 있다. 예를 들어 새벽 2시 실행이 controller 장애 때문에 오전 10시에 발견됐을 때, 8시간 늦어도 전날 데이터를 처리해야 하는가, 아니면 다음 날 정상 실행을 기다려야 하는가를 정한다. 이 값이 없다고 모든 누락 실행이 영원히 재생성되는 것도 아니고, 값이 있다고 업무 정합성이 자동으로 보장되는 것도 아니다.

deadline을 정할 때는 데이터의 유효 기간과 중복 가능성을 같이 본다. 밤 2시 환율 snapshot이 오전 10시에 실행돼도 된다면 넓은 deadline이 가능하다. 하지만 영업일 마감 후 전날 주문을 확정하는 job은 다음 날 중복 실행이 회계에 영향을 줄 수 있다. 이 경우 scheduled timestamp를 업무 키에 넣고, 이미 처리한 날짜라면 no-op으로 끝내는 ledger가 더 중요하다.

## Job 실패를 읽는 방법

### backoffLimit은 재시도 횟수의 계약이다

Job template의 `backoffLimit`은 실패한 Pod를 얼마나 다시 시도할지 제한한다. 값이 크면 일시적인 네트워크 오류를 견딜 기회가 늘 수 있지만, 잘못된 credential·schema·입력 데이터·코드 버그에도 같은 작업을 반복한다. 값 하나를 크게 두는 대신 오류를 분류해야 한다. timeout이나 일시적 5xx에는 제한된 retry가 맞을 수 있고, validation error나 권한 없음에는 재시도보다 즉시 실패와 알림이 낫다.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-order-summary
spec:
  schedule: "0 2 * * *"
  timeZone: "Asia/Seoul"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 3600
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: summary
              image: registry.example.com/reporting:2026-11-17
              args: ["daily-summary", "--date=$(SCHEDULE_DATE)"]
```

이 manifest는 구조 예시다. 실제 container가 `SCHEDULE_DATE`를 어떻게 받는지, image가 어떤 권한으로 database에 접근하는지, 실패 exit code를 어떻게 구분하는지는 별도로 설계해야 한다. `restartPolicy: Never`는 Job controller가 새 Pod를 만들어 재시도하게 하는 모델과 잘 맞을 수 있지만, container 내부에서 무한 retry loop를 만들면 `backoffLimit`의 의미가 약해진다.

### activeDeadlineSeconds와 timeout

작업이 영원히 끝나지 않는 상황도 실패로 다뤄야 한다. database lock 대기, 외부 API의 무한 응답 대기, bug로 인한 loop, queue consumer의 멈춤은 Pod가 Running 상태인 채 다음 CronJob 실행을 막을 수 있다. Job의 `activeDeadlineSeconds` 같은 상한을 두고, application client timeout·context cancellation·graceful shutdown과 맞춘다.

timeout이 되면 단순히 Pod를 죽이는 것으로 끝나면 안 된다. 반쯤 생성된 파일, 부분적으로 보낸 이메일, 진행 중인 batch record, DB transaction이 어떤 상태인지 알고 있어야 한다. 중요한 작업은 시작 시 run ID를 만들고, 실행 단계와 결과를 저장하며, 다음 실행이 같은 run을 안전하게 이어받거나 보류할 수 있게 한다. Kubernetes가 process를 종료하는 기능과 업무 작업을 원자적으로 되돌리는 기능은 다르다.

## 멱등성: 중복 실행을 두려워하지 않게 만드는 설계

CronJob 운영의 핵심은 "절대 두 번 실행되지 않는다"가 아니라 "두 번 실행되어도 결과가 망가지지 않는다"에 가깝다. controller 장애, 사람이 만든 수동 Job, CI 재배포, 네트워크 timeout 뒤 재시도는 언제든 중복처럼 보이는 상황을 만들 수 있다. 아래처럼 업무 키를 정의한다.

| 업무 | 멱등 키의 예 | 중복 시 처리 |
| --- | --- | --- |
| 일별 정산 | merchant + business_date + version | 이미 확정이면 no-op 또는 비교 |
| 이메일 요약 | user + date + template_version | 발송 ledger가 있으면 재발송 금지 |
| 데이터 export | source snapshot + destination key | 임시 경로 후 원자적 rename |
| 만료 데이터 삭제 | partition/date + policy version | 삭제 범위와 결과 count 기록 |

예를 들어 일별 보고서를 object storage에 저장할 때 `report/2026-11-17.csv`를 바로 쓰면 두 실행이 동시에 같은 파일을 덮어쓸 수 있다. 먼저 run ID가 있는 임시 경로에 쓰고, checksum과 row count를 확인한 뒤 최종 경로로 publish한다. 이미 최종 파일이 있으면 overwrite하기보다 manifest와 version을 비교하고, 의도된 재생성인지 운영자 승인이 필요한지 판단한다.

database 작업도 마찬가지다. "오늘 집계가 없으면 INSERT" 같은 코드는 동시 실행에서 race가 될 수 있다. unique constraint, upsert, transaction, status ledger를 조합해 한 business date의 완료 상태를 명시한다. 단, unique constraint가 있다고 외부 API 호출의 중복까지 막히지는 않는다. 외부 provider가 idempotency key를 지원하는지 확인하고, 없으면 내부 ledger에서 호출 전에 상태를 reserve하는 절차를 둔다.

## 구체적인 업무 예시: 매일 새벽 개인정보 보존 기간 삭제

쇼핑 서비스가 개인정보 보존 기간이 지난 주문 부속 데이터를 매일 새벽 삭제한다고 하자. 처음에는 CronJob이 `DELETE`를 실행하고 성공하면 끝나는 것으로 보인다. 하지만 삭제 범위가 크면 database lock·replication·WAL·다른 batch에 영향을 줄 수 있고, job이 중간에 죽으면 어느 기간까지 처리했는지 알기 어렵다.

먼저 업무 owner와 삭제 기준을 정한다. 기준 시각은 `Asia/Seoul`의 업무일인가 UTC인가, legal hold 대상은 제외되는가, 삭제가 복구 불가능한가, 월말에 추가 보존 기간이 있는가를 문서화한다. 다음으로 한 번에 전체 기간을 지우지 말고 primary key 또는 날짜 범위의 작은 chunk를 처리하고, 각 chunk의 시작·종료·row count·run ID를 ledger에 남긴다. 다시 실행될 때는 완료된 chunk를 건너뛰고, 미완료 chunk만 재개한다.

CronJob 수준에서는 `Forbid`로 같은 cleanup의 겹침을 줄이고, `startingDeadlineSeconds`로 너무 늦은 catch-up을 막을 수 있다. Job 수준에서는 짧은 database statement timeout, active deadline, backoff limit을 둔다. application 수준에서는 삭제 대상 snapshot과 legal hold filter를 다시 확인하고, chunk commit 뒤에만 ledger를 완료 처리한다. 이 세 층이 함께 있어야 controller 재시작·Pod 종료·DB failover가 생겨도 삭제 범위를 설명할 수 있다.

## 관찰성과 알림

CronJob의 `lastScheduleTime`이나 Job의 `Complete` condition만 확인하면 부족하다. 성공으로 보인 Job이 업무 데이터 0건을 처리했거나, 실패한 Job이 다음 일정에서 건너뛰어 누락될 수 있다. 운영 대시보드에는 일정 시각, Job 생성 여부, Pod 시작·종료, exit code, 처리 건수, business key 완료 상태, 외부 API 결과를 함께 남긴다.

알림도 목적별로 나눈다. Job 하나가 실패했다고 즉시 pager를 울릴 필요는 없지만, 보존 기간 삭제가 며칠 연속 누락되거나 정산 파일이 마감 전까지 publish되지 않으면 운영 대응이 필요하다. 반대로 retry 중인 일시 오류를 모두 알리면 중요한 신호가 묻힌다. 업무 deadline, 재시도 가능성, 수동 복구 난이도를 기준으로 warning과 critical을 구분한다.

실행 로그에는 secret, 고객 원문, access token을 남기지 않는다. run ID, business date, 처리량, 단계, 오류 코드, 외부 request ID 정도를 구조화해 남기면 충분한 경우가 많다. 실패 조사에 입력 전문이 필요하면 접근 제어된 위치에서 최소 범위로 확인하고 보존 기간을 정한다.

## 배포와 변경 관리

CronJob manifest를 바꾸는 일은 다음 실행부터 업무 결과를 바꿀 수 있는 배포다. schedule, image tag, command argument, service account, 환경 변수, concurrency policy가 바뀌면 기존 runbook도 다시 검증한다. 특히 image tag를 `latest`처럼 가변 값으로 두면 어제 성공한 작업이 오늘 다른 code를 실행할 수 있다. 배치 image와 migration·config version을 고정하고, 변경 commit과 실행 결과를 연결한다.

변경을 적용하기 전에는 같은 command를 one-off Job으로 test namespace에서 실행해 본다. 이때 실제 production database나 외부 고객 API를 사용하지 않고, 승인된 sandbox·read-only credential·synthetic data를 쓴다. test가 통과했다고 production schedule이 맞는 것은 아니므로, 적용 뒤 첫 CronJob이 예상 시각에 Job을 만들었는지와 business result를 운영자가 확인한다. CronJob을 새로 만든 날에는 history limit이 충분해 첫 실행의 Pod·event·log를 조사할 수 있게 한다.

### suspend는 비상 정지 장치다

`spec.suspend: true`는 새 Job 생성을 잠시 멈추는 데 쓸 수 있다. 하지만 이미 실행 중인 Job을 자동으로 중단하거나, 이미 외부 system에 보낸 요청을 되돌리는 기능은 아니다. incident 때 suspend를 켰다면 현재 active Job, queue, database transaction, 이미 생성된 Job을 따로 확인한다. resume 뒤 밀린 schedule을 어떻게 다룰지도 starting deadline과 업무 ledger 기준으로 판단한다.

임시로 suspend한 이유와 재개 조건을 기록하지 않으면, 며칠 뒤 정산·cleanup이 조용히 멈춘 상태로 남을 수 있다. 운영 알림에는 "마지막 성공 시각"과 "현재 suspend 상태"를 함께 노출하고, 오래 suspend된 CronJob은 owner에게 확인하도록 한다. 스케줄러 설정은 code review를 통과했어도 업무 프로세스가 멈춰 있으면 성공이 아니다.

## 리소스와 보안 경계

batch Pod에도 CPU·memory request와 limit을 둔다. request가 없으면 node resource 경쟁에서 예측하기 어렵고, limit이 너무 낮으면 OOMKilled가 반복될 수 있다. 다만 limit을 크게 주는 것이 안전의 답은 아니다. 같은 시각에 여러 CronJob이 시작하면 cluster capacity와 database connection이 동시에 압박될 수 있다. 주요 batch에는 실행 시각을 분산하거나 PriorityClass·ResourceQuota·namespace 정책을 검토한다.

service account는 CronJob이 실제로 필요한 Kubernetes API와 외부 credential만 접근하게 한다. `default` service account에 넓은 권한을 주거나, 하나의 batch가 여러 업무의 secret을 모두 읽게 하면 job image가 손상됐을 때 영향 범위가 커진다. 외부 database password와 API key는 Secret·workload identity 등 조직의 표준 방법으로 전달하고, 로그·환경 출력·debug shell에 노출되지 않도록 한다.

## 반복 작업을 위한 운영 runbook

### 실행 전

업무 owner는 실행 날짜와 대상 범위, 이전 실행 완료 여부, 예정된 대형 변경을 확인한다. 플랫폼 담당자는 cluster capacity, image registry, service account, secret rotation, namespace quota를 확인한다. 데이터 작업이면 DB owner가 lock·backup·replication·maintenance window를 확인한다. 이 체크를 매일 사람이 모두 수행하라는 뜻은 아니며, 자동 health check와 dashboard가 어떤 조건을 보장하고 예외 때 누가 판단하는지 정하라는 뜻이다.

### 실행 중

Job이 시작됐는지뿐 아니라 application이 각 단계에서 진행하는지 본다. long-running task라면 마지막 progress timestamp와 처리량을 남겨, Pod가 Running이지만 아무 일도 못 하는 상태를 찾는다. 외부 API가 rate limit을 반환하면 즉시 무한 retry하지 않고 backoff·최대 시도·deadline을 적용한다. 예상보다 긴 실행은 다음 schedule과 겹칠 수 있으므로, concurrency policy가 실제 업무에 어떤 결과를 낼지 알림에서 보여 준다.

### 실행 후

Job Complete condition, exit code, 처리 건수, business ledger, output artifact를 대조한다. 성공 처리된 날짜의 report가 비어 있거나 checksum이 맞지 않으면 Kubernetes 관점의 success만으로 끝내지 않는다. 실패한 경우에는 관련 Job·Pod·run ID·오류 분류를 ticket에 남기고, retry가 안전한지와 수동 보정이 필요한지 판단한다. 이 기록이 다음 실행에서 같은 문제를 중복 처리하지 않는 기준이 된다.

## CronJob manifest를 읽는 세부 기준

### Job template은 독립적으로 실행 가능해야 한다

CronJob의 `jobTemplate`은 CronJob controller가 매번 복사해 Job을 만드는 템플릿이다. 따라서 template 안의 Pod spec은 사람이 `kubectl create job --from=cronjob/...`으로 수동 실행해도 의미가 통하는 형태가 좋다. 환경 변수에 "현재 날짜"가 필요하다면 container가 system clock을 읽는지, controller가 주입한 scheduled timestamp를 쓰는지, 업무 ledger에서 대상 date를 결정하는지 명확히 한다. 수동 재처리 때 오늘 날짜를 기본으로 계산하면 과거 날짜의 재실행이 엉뚱한 데이터를 처리할 수 있다.

image와 command도 재현 가능하게 기록한다. 같은 `daily-cleanup` command라도 image digest, configuration version, migration 상태가 다르면 결과가 달라질 수 있다. production job의 container가 어떤 code revision을 실행했는지 모르고서는 실패를 재현하거나 이전 정상 실행과 비교하기 어렵다. image tag, ConfigMap version, Secret version 또는 workload identity 변경을 run metadata에 남기면 incident 조사 시간이 줄어든다.

### Pod restart와 Job retry를 혼동하지 않는다

Pod의 `restartPolicy`와 Job의 `backoffLimit`은 서로 다른 층의 동작이다. container 내부 process가 실패했을 때 Pod가 재시작되는 경우와, Job controller가 실패한 Pod를 보고 새 Pod를 만드는 경우는 log·side effect·attempt count를 다르게 만들 수 있다. batch의 한 attempt가 외부 API에 요청을 보낸 뒤 process가 종료됐다면, 새 Pod가 같은 요청을 다시 보내지 않도록 application의 idempotency key가 필요하다.

또한 exit code만으로 모든 실패를 표현하려 하지 않는다. 비즈니스 검증 실패, 입력 없음, upstream 일시 오류, 권한 오류, 사용자 취소는 같은 exit code가 아니어야 운영자가 재시도 정책을 구분할 수 있다. application은 오류 종류와 retry 가능 여부를 structured log·metric으로 남기고, Job은 최종 성공·실패라는 단순 상태로 받아들이는 편이 역할 분리에 맞다.

### 완료된 Job을 너무 빨리 지우지 않는다

history limit이나 TTL controller로 Job을 정리하면 API object가 쌓이는 것을 막을 수 있다. 그러나 너무 짧은 보존은 실패 뒤 Pod event와 exit code를 확인할 기회를 없앤다. 로그가 별도 observability system에 안전하게 보존되고, run ledger에 target·version·outcome이 저장되며, incident 대응자가 그 시스템에 접근할 수 있는지 확인한 뒤 history를 줄인다. log retention이 짧은데 Job도 즉시 삭제되면 "작업이 실패했다"는 알림만 남고 원인을 알 수 없다.

반대로 실패 Job을 무기한 남기면 namespace 목록과 alert가 오래된 오류로 가득 찬다. 성공·실패 history limit, log retention, artifact retention, business ledger retention은 같은 기간일 필요가 없지만 서로의 공백을 메워야 한다. 예를 들어 Job object는 일주일, 상세 log는 한 달, 정산 ledger는 법적 보존 기간처럼 목적에 맞게 정할 수 있다.

## 흔한 장애 패턴과 대응

### 패턴 1: 스케줄은 보이는데 Job이 없다

CronJob이 존재하고 schedule도 맞는데 Job이 생성되지 않는다면 먼저 `suspend`, controller manager 상태, API server 접근, starting deadline, concurrency policy를 확인한다. 이전 Job이 계속 Active 상태라 Forbid가 새 실행을 막았을 수도 있다. schedule을 수정한 직후라면 time zone과 next schedule 계산이 기대와 같은지 확인한다. 단순히 CronJob을 삭제하고 다시 만들면 과거 상태와 누락된 business date 판단 근거를 잃을 수 있다.

### 패턴 2: Job은 성공인데 결과가 없다

exit code 0은 process가 정상 종료했다는 뜻이지 목표 데이터가 생성됐다는 뜻은 아니다. 잘못된 environment variable 때문에 대상 날짜가 비어 있거나, API가 빈 목록을 정상 응답했거나, output upload가 비동기로 실패했을 수 있다. 결과 artifact의 size·checksum·row count·business date와 ledger 상태를 검사하고, 최소 처리 건수 또는 명시적 no-data 사유를 log에 남긴다. 데이터가 없을 수 있는 업무라면 0건도 정상 상태로 표현하되, 예상치와 다를 때 알림을 낼 수 있어야 한다.

### 패턴 3: 같은 날짜가 여러 번 처리된다

controller의 재조정, 운영자의 수동 실행, CI deploy 중복, network timeout 뒤 application retry로 동일 날짜가 두 번 실행될 수 있다. 원인을 찾을 때 Job 이름만 비교하면 부족하다. run ID, business date, input snapshot, external request ID, ledger attempt를 대조한다. 중복이 이미 발생했다면 숨기지 말고 어떤 결과가 publish됐는지, 외부 system에 몇 번 요청했는지, 보정이 필요한지 먼저 결정한다. 이후에는 database unique key, atomic output publish, provider idempotency key처럼 실제 side effect 경계에 방어를 둔다.

### 패턴 4: Job이 계속 Pending이다

Pending Pod는 cron 표현식 문제가 아니라 scheduler·node·resource 문제일 가능성이 크다. request가 node에 맞지 않거나, taint·toleration·affinity·quota·image pull·PVC binding이 막혔는지 event를 본다. 중요한 일일 작업이라면 첫 실행이 종료할 때까지 기다리지 말고, 시작 지연 자체를 alert 조건에 넣는다. deadline이 지나기 전에 사람이 대응할 시간이 있어야 한다.

### 패턴 5: 재시도 때문에 외부 시스템이 더 불안정해진다

external API가 429나 503을 주는데 Job이 짧은 간격으로 Pod를 새로 만들고, 각 Pod가 내부에서도 여러 retry를 하면 요청 폭주가 커진다. retry budget은 Job·HTTP client·queue consumer 중 한 곳에서 책임을 명확히 하고, 다른 층은 deadline과 cancellation을 존중한다. `Retry-After` 같은 server signal, exponential backoff, jitter, 최대 실행 시간을 적용한다. 일시 오류가 아닌 400·401·403·validation error는 재시도하지 않고 configuration 또는 data issue로 분리한다.

## 업무 위험도별 적용 방식

| 작업 유형 | 실행 중단의 영향 | 권장 운영 방식 |
| --- | --- | --- |
| 캐시 정리·통계 수집 | 다음 실행에서 보완 가능 | Allow 또는 제한된 retry, 처리량 관찰 |
| 보고서 생성 | 마감 전 재실행 가능 | Forbid + artifact version + 완료 알림 |
| 데이터 동기화 | 중복·순서 문제 가능 | ledger·checkpoint·atomic publish |
| 정산·청구 | 금전 정합성 영향 | business date lock, 승인·대사, 보수적 재시도 |
| 삭제·보존 기간 처리 | 복구 어려움·법적 영향 | dry run, chunk ledger, hold filter, human escalation |

이 표는 YAML 설정을 자동으로 결정하지 않는다. 같은 보고서라도 외부 고객에게 발송되면 중복의 영향이 커지고, 같은 cleanup도 법적 hold가 있으면 사람 검토가 필요하다. CronJob의 장점은 반복적인 실행을 선언적으로 만들 수 있다는 것이며, 선언 밖의 업무 규칙까지 대신 해 주지는 않는다.

## 테스트 전략

CronJob은 정해진 시간이 와야만 확인할 수 있다고 생각하기 쉽지만, 대부분의 검증은 one-off Job과 fake input으로 앞당길 수 있다. command가 주어진 business date와 run ID를 정확히 처리하는지 unit·integration test로 확인하고, test namespace에서 Job을 실행해 service account·secret mount·network policy·resource request가 맞는지 본다. cron schedule 자체는 lint 또는 controller가 계산한 next schedule을 확인하는 test로 검증한다.

실패 시나리오도 만든다. database timeout, object storage upload 실패, duplicate ledger key, external 429, Pod eviction, image pull failure를 안전한 환경에서 주입하고, backoff·alert·cleanup·재실행 경로가 의도대로 작동하는지 확인한다. 테스트 목적은 모든 장애를 완벽히 모사하는 것이 아니라, 실패가 발생했을 때 중복 side effect 없이 원인과 다음 행동을 알 수 있는지 확인하는 것이다.

## 일정 변경과 휴일 처리

업무 schedule은 고정된 cron 식보다 자주 바뀐다. 공휴일에는 실행하지 않아야 하거나, 월말에는 더 늦게 실행해야 하거나, 분기 마감에는 수동 승인 뒤 실행해야 할 수 있다. cron 표현식에 모든 업무 예외를 억지로 넣으면 읽기 어렵고 수정 실수가 늘어난다. CronJob은 규칙적인 실행 신호로 두고, application이 business calendar·휴일·마감 상태·승인 여부를 확인해 안전하게 no-op 또는 대기하도록 설계하는 방법을 검토한다.

다만 "no-op"도 관찰 가능해야 한다. 휴일이라 실행하지 않은 것인지, calendar service가 실패해 모든 실행을 건너뛴 것인지 구분할 수 있어야 한다. 결과 상태를 `completed`, `skipped_by_calendar`, `waiting_for_approval`, `failed`처럼 업무 의미로 남기고, 장기간 예상 밖 skip이 생기면 알림을 준다. Kubernetes Job이 0으로 종료한 것만으로는 그 차이를 알 수 없다.

### 수동 재실행 요청

운영자는 종종 어제 보고서를 다시 만들거나 실패한 날짜만 재처리해야 한다. 이때 CronJob의 schedule을 임시로 바꾸는 방식은 위험하다. 과거 날짜를 명시적으로 받고, 실행자·사유·대상 범위·dry run 여부를 기록하는 one-off Job 또는 승인된 운영 명령을 사용한다. 수동 job도 동일한 business ledger와 idempotency key를 공유해야 하며, 정상 schedule job과 겹칠 수 있는지 확인한다.

수동 재실행은 편의를 위해 production credential을 넓게 제공하는 계기가 되기 쉽다. 운영 UI나 CLI는 역할 기반 권한, 대상 범위 제한, audit log, confirmation을 갖추고, 파괴적 작업은 두 사람 승인 같은 조직 절차를 따른다. 반복 작업을 자동화한다고 사람이 책임 없이 임의 실행할 수 있게 만드는 것은 아니다.

## 체크리스트를 실행 순서로 바꾸기

새 CronJob을 만들 때 다음 흐름으로 review하면 설정 누락을 줄일 수 있다.

1. 이 작업은 반복 Job에 맞는가, queue 또는 workflow engine이 더 적합한가를 결정한다.
2. 업무 날짜·time zone·입력 snapshot·중복 처리 기준을 owner와 합의한다.
3. Job command를 one-off 형태로 test environment에서 실행하고 output을 검증한다.
4. service account, secret, network, resource request·limit, deadline을 최소 권한으로 설정한다.
5. concurrency policy, backoff, catch-up, history retention을 업무 영향과 연결한다.
6. dashboard와 alert에 Kubernetes 상태와 business result를 모두 연결한다.
7. 첫 production 실행은 담당자가 결과와 ledger를 확인하고, 다음 일정 전에 문제를 보정한다.

이 순서는 모든 작업을 느리게 승인하려는 절차가 아니다. 배치가 실패했을 때 원인을 찾고 안전하게 재시작하는 데 필요한 최소 정보를 처음부터 갖추는 방법이다. CronJob은 간단한 YAML이지만, 그 안에서 실행되는 업무는 간단하지 않을 수 있다.

## 운영 지표의 기준선 만들기

새 job을 만든 첫날부터 실패만 보지 말고 정상 실행의 기준선도 남긴다. 시작 지연, 실행 시간, 처리 건수, 재시도 수, DB·외부 API 호출 수, artifact 크기를 일정 기간 기록하면 이후 느려짐과 데이터 급증을 구분할 수 있다. 예를 들어 처리 건수가 두 배가 됐는데 실행 시간이 늘어난 것은 정상일 수 있지만, 같은 건수에서 실행 시간이 급증하면 image·query plan·외부 dependency·cluster resource를 조사할 신호가 된다.

기준선은 평균 하나보다 범위가 유용하다. 주말·월말·대규모 고객 데이터처럼 workload가 달라지는 날을 구분하고, 업무 deadline에 맞춘 경고를 정한다. "30분이 넘으면 실패"가 아니라 "마감 30분 전인데 완료율이 80% 미만"처럼 업무 결과를 기준으로 알리면 불필요한 경보를 줄일 수 있다.

## 책임자 인수인계

CronJob owner가 바뀌거나 서비스가 폐기될 때도 schedule은 남을 수 있다. manifest에 owner·업무 목적·runbook 위치·폐기 조건을 annotation 또는 운영 문서로 연결한다. 더 이상 쓰지 않는 CronJob은 suspend만 해 두기보다 관련 secret·service account·alert·dashboard와 함께 정리할지 결정한다. 남겨진 작업은 미래에 의도하지 않은 비용·권한·데이터 변경을 만들 수 있다.

## 마무리 전 검증의 의미

CronJob을 적용한 뒤 `kubectl apply`가 성공했다는 사실은 설정 파일이 API server에 저장됐다는 뜻일 뿐이다. 첫 scheduled Job이 실제 시간대에 생성됐는지, Pod가 올바른 image와 권한으로 시작됐는지, 결과가 business ledger에 반영됐는지까지 봐야 한다. 이 검증은 배포 직후 한 번만 하는 일이 아니라, image·schedule·dependency·권한이 바뀔 때 다시 수행하는 운영 습관이다.

작업이 정상일 때의 실행 경로를 알고 있으면 incident에서 덜 추측하게 된다. 누락·중복·지연의 차이를 controller 상태와 업무 상태에서 각각 확인하고, 무작정 재실행하기 전에 멱등성·대상 날짜·side effect를 확인한다.

이 원칙은 작은 cron 작업에도 적용된다. 처음에는 단순했던 batch가 데이터 증가와 조직 변화로 중요한 업무가 될 수 있으므로, 실행 의도와 검증 기준을 manifest 가까이에 남겨 둔다.

## 이력 정리와 debugging

`successfulJobsHistoryLimit`과 `failedJobsHistoryLimit`은 오래된 Job 객체를 얼마나 남길지 정한다. 이 값이 너무 작으면 실패 원인을 찾기 전에 Pod와 log reference가 사라지고, 너무 크면 API object와 monitoring 대상이 불필요하게 쌓인다. history limit은 로그 보존 정책과 같이 정한다. Job 객체를 지워도 외부 logging system에 필요한 log가 남는지, artifact가 별도 bucket에 보관되는지 확인한다.

CronJob 문제가 생기면 다음 순서로 확인한다.

1. CronJob의 schedule, timeZone, suspend 여부, last schedule time을 확인한다.
2. 예정 시각에 Job이 생성됐는지, concurrency policy나 deadline 때문에 건너뛰지 않았는지 확인한다.
3. Job의 실패 횟수·condition·생성한 Pod 목록을 본다.
4. Pod의 event, exit code, application log, resource limit·image pull·service account 권한을 확인한다.
5. 업무 ledger와 결과 저장소에서 실제 business date가 완료됐는지 대조한다.

`kubectl get cronjob`, `kubectl get job`, `kubectl describe job`, `kubectl logs job/<name>`은 유용한 출발점이지만 Kubernetes 상태만으로 업무 완료를 증명하지 않는다. 특히 외부 API 호출이나 database commit이 있는 job은 application log와 target state를 반드시 함께 본다.

## 한계와 적용 기준 Q&A

### Q. CronJob이 놓친 실행을 자동으로 모두 보충하면 안전한가요?

A. 아니다. 놓친 기간을 자동으로 여러 번 실행하면 같은 business date를 중복 처리하거나 현재 상태와 맞지 않는 오래된 작업을 시작할 수 있다. catch-up이 필요한 업무라면 기간별 ledger와 idempotency key를 두고, 어떤 날짜까지 자동 보충할지와 그 이후 수동 승인 기준을 정한다.

### Q. `concurrencyPolicy: Forbid`면 데이터 중복은 해결되나요?

A. 아니다. CronJob이 만든 Job 사이의 겹침만 다룬다. 수동 Job, 다른 cluster, deploy retry, application 내부 retry, 외부 system의 재전송은 별도 경로다. database unique constraint, object version, external idempotency key 같은 업무 수준 방어가 필요하다.

### Q. 매일 실행이 늦어지면 worker CPU를 늘리면 되나요?

A. 원인을 먼저 분류해야 한다. Job 생성이 늦는지, image pull이 늦는지, scheduler가 Pod를 배치하지 못하는지, application이 database lock을 기다리는지, 외부 API가 느린지에 따라 해결책이 다르다. CPU limit을 늘리는 것은 계산 부족일 때만 도움이 된다.

### Q. CronJob이 맞지 않는 경우는 언제인가요?

A. 초 단위 정밀 실행, 장시간 상호작용 워크플로, 대량 작업의 동적 fan-out, 복잡한 승인·재시도·의존성 그래프가 필요하면 별도 workflow engine 또는 queue 기반 worker가 더 적합할 수 있다. CronJob은 반복적으로 Job을 생성하는 단순하고 명확한 작업에 가장 잘 맞는다.

## 실무 점검 목록

- schedule과 time zone이 업무 날짜 기준과 일치하는가?
- Allow·Forbid·Replace 중 중복과 누락에 대한 업무 결정을 반영했는가?
- starting deadline과 active deadline이 있으며, 늦은 실행의 처리 기준이 있는가?
- backoff limit이 오류 유형과 외부 부작용을 고려한 값인가?
- run ID·business key·업무 ledger로 중복과 재시작을 설명할 수 있는가?
- resource request·limit, database/API timeout, service account 권한을 점검했는가?
- Job history, log, artifact, 실패 알림의 보존 정책이 연결되는가?
- Kubernetes 완료 상태와 실제 업무 결과를 함께 검증하는가?

## 마무리

Kubernetes CronJob은 cron 식 하나를 저장하는 기능이 아니라, 반복 작업을 Job과 Pod의 상태 모델로 운영하게 하는 도구다. 안전한 운영은 실행 시각보다 중복·누락·실패·정리의 의미를 먼저 정하는 데서 시작한다. concurrencyPolicy와 deadline은 controller 수준의 제어이고, 진짜 정합성은 business key와 멱등성 ledger, 원자적 publish, timeout과 복구 절차에서 만들어진다.

처음에는 영향이 낮은 보고서나 cache warm-up 같은 작업에서 run ID와 결과 검증을 도입해 보자. 그 다음 정산·삭제처럼 위험도가 높은 작업으로 확대하되, Kubernetes의 Job 상태와 업무 완료 상태를 분리해 관찰한다. 이렇게 하면 새벽에 "CronJob은 성공인데 왜 데이터가 없지?"라는 질문에 추측이 아니라 실행 이력으로 답할 수 있다.

<h3 class="references-heading">참고 자료</h3>

- [Kubernetes: CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [Kubernetes: Job](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
- [Kubernetes: Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Kubernetes API reference: CronJob](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/cron-job-v1/)
