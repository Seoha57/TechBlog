---
layout: post
title: "PostgreSQL로 작업 큐 만들기: FOR UPDATE SKIP LOCKED·리스 설계·재시도와 운영 진단"
categories: [DBA]
tags: [dba, postgresql, skip-locked, job-queue, row-lock, concurrency, mvcc, vacuum]
description: "여러 워커가 같은 테이블에서 작업을 가져갈 때 중복 처리와 락 대기를 피하는 PostgreSQL의 FOR UPDATE SKIP LOCKED 패턴을, 큐 테이블 설계·리스(lease)·재시도·인덱스·진단 쿼리와 함께 정리하고 전용 메시지 브로커와의 선택 기준까지 설명합니다."
---

## 먼저 답하기

### Q. 메시지 브로커 없이 데이터베이스 테이블만으로 작업 큐를 만들어도 되나요?

A. 작업량이 초당 수십~수백 건 수준이고, 작업 등록이 이미 데이터베이스 트랜잭션 안에서 이루어지는 시스템이라면 충분히 현실적인 선택입니다. 주문을 저장하는 같은 트랜잭션 안에서 "주문 확인 메일 발송" 작업을 큐 테이블에 넣으면, 주문은 저장됐는데 작업은 사라지거나 그 반대가 되는 불일치가 원천적으로 없어지기 때문입니다. 별도 인프라를 늘리지 않아도 되는 점도 장점입니다. 반대로 초당 수천 건 이상의 처리량, 여러 소비자 그룹에 같은 메시지를 나눠 주는 발행·구독, 장기간 이벤트 보관과 재생이 핵심이라면 Kafka나 RabbitMQ 같은 전용 시스템이 맞습니다. 이 글은 PostgreSQL을 기준으로 하며, 예시 SQL과 결과는 설명을 위한 것이고 제가 직접 측정한 성능 수치가 아닙니다. 적용 전에 본인의 버전과 데이터에서 반드시 실행해 확인하세요.

### Q. 워커를 여러 개 띄우면 같은 작업을 두 번 가져가지 않나요?

A. 아무 장치 없이 `SELECT ... LIMIT 1`로 가져가면 두 워커가 같은 행을 읽을 수 있어 중복 처리가 생깁니다. 이를 막으려고 `SELECT ... FOR UPDATE`로 행을 잠그면 중복은 사라지지만, 뒤에 온 워커가 앞선 워커의 잠금이 풀릴 때까지 줄을 서서 기다리므로 워커를 늘려도 처리량이 늘지 않습니다. `FOR UPDATE SKIP LOCKED`는 "이미 다른 트랜잭션이 잠근 행은 기다리지 말고 건너뛰라"는 옵션입니다. 그래서 워커 A·B·C가 동시에 실행되면 각자 서로 다른 행을 하나씩 가져가 병렬로 일합니다. 다만 이 옵션은 결과가 "잠긴 행이 빠진, 불완전한 시점의 데이터"일 수 있다는 점을 PostgreSQL 공식 문서도 경고하므로, 큐처럼 "아무 미처리 행이나 하나 가져오면 되는" 용도에만 씁니다.

## 먼저 알아둘 기반 기술

이 절은 본문을 읽는 데 필요한 사전 개념을 가장 밑바닥에서 시작해 `SKIP LOCKED` 직전까지 차례로 쌓습니다. 작업 큐라는 문제의 모양, 트랜잭션과 행 잠금, MVCC와 격리 수준에서 잠긴 행을 만났을 때의 동작, 인덱스와 실행 계획, 장시간 트랜잭션과 vacuum의 관계 순서입니다. 각 소절 끝에는 그 개념이 본문의 어느 절로 이어지는지 적었고, 절 마지막에 전체 연결을 표로 정리했습니다.

### 작업 큐와 처리 보장: "적어도 한 번"이라는 현실

작업 큐(job queue)는 "지금 당장 처리하지 않아도 되는 일"을 목록에 적어 두고 별도의 일꾼(워커, worker)이 하나씩 꺼내 처리하게 하는 구조입니다. 식당에서 홀 직원이 주문서를 주방 앞 꽂이에 꽂으면 요리사들이 한 장씩 뽑아 가는 모습과 같습니다. 생산자(producer)는 작업을 넣기만 하고, 소비자(consumer)는 가져가서 처리합니다. 웹 요청 안에서 메일 발송이나 외부 결제 확인처럼 오래 걸리고 실패할 수 있는 일을 하면 사용자가 기다려야 하므로 큐로 분리합니다.

큐에서 가장 중요한 질문은 "작업이 몇 번 실행되는가"입니다. 분산 시스템에서는 워커가 작업을 끝낸 직후 죽으면 완료 기록이 남지 않아 같은 작업이 한 번 더 실행될 수 있습니다. 그래서 현실적인 목표는 "적어도 한 번(at-least-once)" 실행을 보장하고, 두 번 실행돼도 결과가 같도록 작업 자체를 멱등(idempotent, 같은 요청을 여러 번 해도 결과가 한 번 한 것과 같은 성질)하게 만드는 것입니다. "정확히 한 번(exactly-once)"은 외부 시스템까지 포함하면 사실상 달성하기 어렵습니다. 이 글의 큐도 적어도 한 번 보장을 전제로 설계합니다.

이 개념을 모르면 본문에서 왜 작업 상태에 `running`과 마감 시각을 두고, 왜 재시도 횟수와 멱등 키를 따로 관리하는지 이해하기 어렵습니다. 이 개념은 아래 「큐 테이블 설계」 절에서 상태 컬럼과 멱등 키로, 「실패·재시도와 리스(lease)」 절에서 워커가 죽은 작업을 되찾는 방식으로 쓰입니다.

### 트랜잭션과 행 잠금: 읽기와 쓰기 사이를 지키는 법

트랜잭션(transaction)은 여러 SQL 문을 "모두 반영되거나 모두 취소되는" 하나의 단위로 묶은 것이고, 끝에서 변경을 확정하는 일이 커밋(commit), 취소하는 일이 롤백(rollback)입니다. 트랜잭션 안에서 어떤 행을 고치려 하면 PostgreSQL은 그 행에 **행 잠금(row lock)** 을 겁니다. 다른 트랜잭션이 같은 행을 고치려면 잠금을 건 트랜잭션이 끝날 때까지 기다려야 합니다. 화장실 문의 "사용 중" 표시와 같아서, 표시가 있는 동안 다음 사람은 문 앞에서 기다립니다.

고치지 않고 읽기만 하는데도 "이 행은 내가 곧 고칠 테니 다른 사람이 건드리지 마라"고 미리 예약하고 싶을 때가 있습니다. 이때 `SELECT ... FOR UPDATE`를 씁니다. 조회한 행에 쓰기용 행 잠금을 걸어 주는 문법입니다. 큐에서는 "미처리 작업 한 건을 읽고, 내가 처리 중이라고 표시할 때까지 다른 워커가 같은 행을 못 가져가게" 하는 용도로 쓰입니다. PostgreSQL은 잠금 강도에 따라 `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`를 제공합니다. 키 컬럼을 바꾸지 않고 상태만 바꾸는 큐 작업에는 외래 키 참조를 덜 방해하는 `FOR NO KEY UPDATE`가 더 약한 잠금이라 적합할 때가 있으며, 이 글에서는 가장 널리 알려진 `FOR UPDATE`로 설명하되 차이를 짚습니다.

여기에 대기 방식을 정하는 옵션이 붙습니다. 기본값은 잠금이 풀릴 때까지 무한정 기다리는 것이고, `NOWAIT`는 잠긴 행을 만나면 기다리지 않고 즉시 오류를 내며, `SKIP LOCKED`는 잠긴 행을 결과에서 빼고 계속 진행합니다. 이 세 가지의 차이가 본문의 핵심입니다. 이 개념은 아래 「일반 FOR UPDATE 폴링이 깨지는 이유」 절에서 줄 서기 문제로, 「SKIP LOCKED가 하는 일」 절에서 세 옵션의 비교로 쓰입니다.

### MVCC와 READ COMMITTED: 잠긴 행을 만나면 무슨 일이 생기나

MVCC(Multi-Version Concurrency Control, 다중 버전 동시성 제어)는 행을 고칠 때 제자리에서 덮어쓰지 않고 새 버전을 만들어 두고, 각 트랜잭션이 자기 시점에 맞는 버전을 보게 하는 방식입니다. 덕분에 읽는 쪽과 쓰는 쪽이 서로 막지 않습니다. 다만 **같은 행을 동시에 쓰려는 두 트랜잭션** 은 서로 막습니다. 새 버전이 두 개 생기면 안 되기 때문입니다. 앞서 기본 개념에서 본 행 잠금이 바로 이 충돌을 정리하는 장치입니다.

PostgreSQL의 기본 격리 수준은 `READ COMMITTED`입니다. 이 수준에서는 SQL 문 하나가 시작되는 시점의 스냅샷을 기준으로 행을 찾습니다. 그런데 `FOR UPDATE`로 잠그려는 행이 이미 다른 트랜잭션에 잠겨 있으면, 뒤에 온 문장은 앞 트랜잭션이 끝날 때까지 기다립니다. 앞 트랜잭션이 커밋하면 뒤 문장은 **그 행의 최신 버전을 다시 가져와 `WHERE` 조건을 다시 평가**합니다. 최신 버전이 더 이상 조건에 맞지 않으면(예를 들어 상태가 이미 `done`으로 바뀌었으면) 그 행은 결과에서 빠집니다. 이 재평가 때문에 일반 `FOR UPDATE` 큐 쿼리는 "1건을 기다렸는데 결과가 0건"이라는 이상한 상황을 만들 수 있고, `ORDER BY`와 함께 쓰면 순서가 어긋난 행이 나올 수도 있습니다.

이 개념을 모르면 본문에서 "왜 FOR UPDATE는 대기 뒤 빈 결과를 돌려주는가", "SKIP LOCKED의 결과가 왜 일관된 스냅샷이 아닌가"가 이해되지 않습니다. 이 개념은 아래 「일반 FOR UPDATE 폴링이 깨지는 이유」 절에서 재평가 동작으로, 「한계와 적용 기준 Q&A」 절에서 격리 수준 질문으로 쓰입니다.

### 인덱스, 부분 인덱스, LIMIT과 실행 계획

인덱스(index)는 책 뒤의 색인처럼 특정 값을 가진 행을 빨리 찾게 해 주는 별도 자료구조이고, PostgreSQL의 기본 형태는 B-tree입니다. 큐 테이블은 대부분의 행이 이미 처리가 끝난 `done` 상태이고, 처리 대기 행은 일부분입니다. 이런 경우 전체 행을 색인하지 않고 조건을 만족하는 행만 색인하는 **부분 인덱스(partial index)** 가 효과적입니다. `CREATE INDEX ... WHERE status = 'queued'`처럼 만들면 처리 대기 행만 담겨 작고 빠르게 유지됩니다.

실행 계획(execution plan)은 옵티마이저가 쿼리를 어떤 순서와 방법으로 처리할지 정한 작업 순서표이고, `EXPLAIN` 명령으로 볼 수 있습니다. 큐 쿼리는 `ORDER BY ... LIMIT 1`에 `FOR UPDATE SKIP LOCKED`가 붙은 모양이라 계획에 `Index Scan`, `LockRows`, `Limit` 노드가 나타납니다. `LockRows`가 행 잠금을 거는 단계입니다. 인덱스가 없으면 워커가 매번 테이블 전체를 훑고, 처리 대기 행이 쌓일수록 한 번의 "가져오기"가 느려집니다.

이 개념을 모르면 본문에서 왜 정렬·필터 조건과 인덱스를 맞추라고 하는지, 진단 쿼리의 실행 계획에서 무엇을 봐야 하는지 알 수 없습니다. 이 개념은 아래 「인덱스와 테이블 관리」 절에서 부분 인덱스 설계로, 「진단 쿼리와 점검 순서」 절에서 `LockRows` 노드 확인으로 쓰입니다.

### 장시간 트랜잭션, 죽은 튜플, VACUUM

PostgreSQL에서 행을 `UPDATE`하면 옛 버전이 곧바로 사라지지 않고 "죽은 튜플(dead tuple, 아무도 더 이상 볼 수 없는 옛 버전 행)"로 남습니다. `VACUUM`(과 자동 실행되는 autovacuum)이 이를 정리해 공간을 재사용 가능하게 만듭니다. 그런데 오래 열려 있는 트랜잭션이 있으면 그 트랜잭션이 볼 수도 있는 옛 버전을 지울 수 없어서 정리가 멈춥니다. 큐 테이블은 한 행이 `queued → running → done`으로 여러 번 갱신되므로 죽은 튜플이 빠르게 쌓이는 대표적인 테이블입니다. 이미 게시한 글 「PostgreSQL Autovacuum 기본기」에서 다룬 원리가 그대로 적용됩니다.

그래서 큐 설계의 철칙은 "행을 잠근 채로 오래 걸리는 외부 작업을 하지 않는다"입니다. 워커가 트랜잭션을 연 채로 외부 API를 30초 호출하면 그동안 잠금이 유지되고, 트랜잭션이 vacuum의 정리 기준선도 붙잡습니다. 이 개념은 아래 「클레임·처리·완료를 트랜잭션 세 개로 나누기」 절에서 짧은 트랜잭션 원칙으로, 「인덱스와 테이블 관리」 절에서 fillfactor와 vacuum 설정으로 쓰입니다.

### 기반 개념과 본문 연결 지도

| 기반 개념 | 쓰이는 본문 절 | 그 절에서의 역할 |
|---|---|---|
| 작업 큐와 at-least-once | 큐 테이블 설계, 실패·재시도와 리스(lease) | 상태 컬럼·멱등 키·재시도 횟수 설계의 전제 |
| 행 잠금과 FOR UPDATE | 일반 FOR UPDATE 폴링이 깨지는 이유, SKIP LOCKED가 하는 일 | 대기 방식 세 가지(기본·NOWAIT·SKIP LOCKED) 비교의 바탕 |
| MVCC와 READ COMMITTED 재평가 | 일반 FOR UPDATE 폴링이 깨지는 이유, 한계와 적용 기준 Q&A | 대기 뒤 빈 결과와 불완전 스냅샷의 원인 |
| 부분 인덱스와 실행 계획 | 인덱스와 테이블 관리, 진단 쿼리와 점검 순서 | 대기 행만 색인하고 `LockRows` 노드를 확인 |
| 장시간 트랜잭션과 VACUUM | 클레임·처리·완료를 트랜잭션 세 개로 나누기, 인덱스와 테이블 관리 | 잠금 보유 시간을 줄이고 죽은 튜플을 관리 |

## 일반 FOR UPDATE 폴링이 깨지는 이유

가장 단순한 구현은 워커가 반복해서 "미처리 작업 한 건"을 조회하고 처리하는 폴링(polling, 주기적으로 확인하기)입니다. 먼저 이 방식의 약점을 단계별로 보겠습니다.

### 잠금 없는 조회는 중복 처리를 만든다

```sql
-- 위험한 첫 구현: 잠금이 없다
SELECT id, payload FROM jobs
WHERE status = 'queued'
ORDER BY id
LIMIT 1;
-- 이후 애플리케이션이 UPDATE jobs SET status='running' WHERE id = :id
```

워커 A와 B가 거의 동시에 이 쿼리를 실행하면 둘 다 같은 `id = 101`을 읽습니다. 그다음에 각자 `running`으로 바꾸고 각자 메일을 보내면 사용자는 같은 메일을 두 통 받습니다. 읽기와 쓰기 사이의 틈에서 벌어지는 이 문제를 경쟁 상태(race condition)라고 합니다. 상태 갱신에 `WHERE status = 'queued'` 조건을 한 번 더 붙이고 영향받은 행 수를 확인하는 낙관적 방식도 가능하지만, 실패한 워커가 헛걸음을 하며 재시도해야 하므로 경쟁이 심할수록 낭비가 커집니다.

### FOR UPDATE만 붙이면 줄을 선다

```sql
BEGIN;
SELECT id, payload FROM jobs
WHERE status = 'queued'
ORDER BY id
LIMIT 1
FOR UPDATE;
-- 여기서 처리 후 UPDATE ... SET status='done'
COMMIT;
```

중복은 사라집니다. 하지만 워커 A가 `id = 101`을 잠그고 처리하는 동안 B와 C도 같은 `id = 101`을 잠그려 하므로 줄을 섭니다. A가 커밋하면 B가 깨어나, 앞서 기반 기술에서 본 READ COMMITTED의 재평가를 합니다. 101번의 최신 상태가 `done`이므로 `WHERE status = 'queued'`를 더 이상 만족하지 않아 B의 결과는 **0행**입니다. 그동안 102번 이하의 처리 대기 행은 아무도 가져가지 않았는데도 B는 빈손으로 돌아가 다시 폴링합니다. 결과적으로 워커를 10개 띄워도 한 번에 한 개씩만 처리되고, 나머지는 잠금 대기로 시간을 씁니다.

<figure class="article-figure"><img src="{{ '/assets/images/postgresql-skip-locked-queue-flow.svg' | relative_url }}" alt="일반 FOR UPDATE에서는 두 번째 이후 워커가 첫 번째 행의 잠금을 기다리고 SKIP LOCKED에서는 잠긴 행을 건너뛰어 워커가 서로 다른 행을 가져가는 구조"><figcaption>그림. FOR UPDATE만 쓰면 워커들이 같은 첫 행 앞에서 줄을 서고, SKIP LOCKED를 쓰면 잠긴 행을 건너뛰어 서로 다른 행을 병렬로 처리한다. 이미지 출처: 직접 제작</figcaption></figure>

## SKIP LOCKED가 하는 일

`SKIP LOCKED`는 `FOR UPDATE` 같은 잠금 절 뒤에 붙이는 옵션으로, 잠그려는 행이 이미 다른 트랜잭션에 잠겨 있으면 그 행을 결과에서 제외하고 다음 행으로 넘어갑니다. PostgreSQL 9.5에서 도입됐고, 현재도 같은 의미로 쓰입니다.

### 세 가지 대기 방식 비교

```sql
-- 1) 기본: 잠금이 풀릴 때까지 기다림
SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE;
-- 2) NOWAIT: 잠긴 행을 만나면 즉시 오류 (SQLSTATE 55P03)
SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE NOWAIT;
-- 3) SKIP LOCKED: 잠긴 행은 건너뛰고 다음 행을 잠금
SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;
```

| 옵션 | 잠긴 행을 만났을 때 | 적합한 용도 | 주의점 |
|---|---|---|---|
| (기본) | 잠금이 풀릴 때까지 대기 후 재평가 | 순서가 엄격해야 하는 단일 소비자 | 워커를 늘려도 처리량이 늘지 않음 |
| `NOWAIT` | 즉시 오류 반환 | 특정 행을 반드시 점유해야 하고 못 하면 알아야 할 때 | 오류 처리와 재시도 코드 필요 |
| `SKIP LOCKED` | 그 행을 결과에서 제외 | 여러 워커가 아무 미처리 행이나 가져가는 큐 | 결과가 일관된 스냅샷이 아니고 엄격한 FIFO가 아님 |

### 불완전한 시점을 일부러 받아들이는 설계

PostgreSQL 공식 문서는 `SKIP LOCKED`가 "일관되지 않은 데이터 뷰(inconsistent view of data)"를 준다고 설명하며 범용 작업에는 적합하지 않고 큐 형태의 테이블에서 여러 소비자가 접근할 때 락 경합을 피하는 용도로 쓸 수 있다고 안내합니다. 이 말은 "큐에서는 잠긴 행이 빠져도 괜찮다"는 뜻입니다. 잠긴 행은 다른 워커가 처리 중이므로 내 몫이 아니고, 내 몫은 잠기지 않은 행 중 하나이기 때문입니다. 반대로 은행 잔액 합계를 구하면서 `SKIP LOCKED`를 쓰면 잠긴 행이 합계에서 조용히 빠져 틀린 답이 나옵니다. 그래서 "이 쿼리의 결과가 일부 행이 빠져도 의미가 있는가"가 사용 여부의 기준입니다.

또 `ORDER BY`와 함께 쓰면 정렬이 먼저 이뤄진 뒤 위에서부터 잠금을 시도하므로 대체로 낮은 `id`부터 가져가지만, 일부 행이 건너뛰어지고 나중에 다시 나타나므로 엄격한 선입선출(FIFO)은 아닙니다. 예를 들어 워커 A가 101번을 처리하다 실패해 롤백하면 101번은 큐에 다시 나타나고, 이미 102번을 가져간 B보다 늦게 처리되며 순서가 뒤바뀝니다. 순서가 비즈니스 규칙이라면 같은 고객의 작업을 한 워커에 몰아주는 파티셔닝이 따로 필요하며, 이는 뒤의 한계 절에서 다시 다룹니다.

## 큐 테이블 설계

이제 실제로 돌려볼 수 있는 큐 테이블을 만듭니다. 이름은 `jobs`로 하고 상태와 재시도 정보를 포함합니다.

### 상태와 컬럼

```sql
CREATE TABLE jobs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue         text        NOT NULL DEFAULT 'default',
  payload       jsonb       NOT NULL,
  status        text        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed')),
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      int         NOT NULL DEFAULT 0,
  max_attempts  int         NOT NULL DEFAULT 5,
  locked_until  timestamptz,
  locked_by     text,
  last_error    text,
  idempotency_key text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
) WITH (fillfactor = 70);
```

각 컬럼의 역할은 다음과 같습니다. `status`는 작업의 생애 단계이고, `run_after`는 "이 시각 이후에 실행하라"는 예약·백오프용 시각입니다. `attempts`와 `max_attempts`는 재시도 횟수와 상한, `locked_until`과 `locked_by`는 뒤에서 설명할 리스(lease)에 쓰입니다. `idempotency_key`는 앞서 기반 기술에서 본 멱등성을 큐 입구에서 보장하는 장치로, 같은 요청이 두 번 들어와도 `UNIQUE` 제약이 두 번째 삽입을 거부합니다. `fillfactor = 70`은 페이지를 70%만 채워 두어 행 갱신 시 같은 페이지 안에 새 버전을 둘 여유를 만드는 설정이며, 갱신이 잦은 큐 테이블에서 의미가 있습니다. 구체적 값은 데이터 특성에 따라 직접 검증해야 합니다.

### 작업 등록은 업무 트랜잭션 안에서

```sql
BEGIN;
INSERT INTO orders (customer_id, amount) VALUES (42, 15000);
INSERT INTO jobs (queue, payload, idempotency_key)
VALUES ('mail', '{"type":"order_confirmation","order_id":1001}', 'order-confirm-1001');
COMMIT;
```

주문과 작업이 한 트랜잭션에서 커밋되므로 둘은 함께 존재하거나 함께 사라집니다. 메시지 브로커를 쓰면 DB 커밋과 브로커 전송 사이의 불일치를 막기 위해 별도의 패턴(아웃박스 패턴 등)이 필요한데, 데이터베이스 큐는 이 문제가 처음부터 없다는 점이 가장 큰 장점입니다. 단, `payload` 안에 큰 데이터를 통째로 넣으면 테이블이 부풀어 vacuum 부담이 커지므로 식별자만 담고 상세는 원본 테이블에서 읽는 편이 좋습니다.

## 클레임·처리·완료를 트랜잭션 세 개로 나누기

작업을 "가져오는(claim)" 단계, "실제로 처리하는" 단계, "완료로 기록하는" 단계로 나눕니다. 핵심은 처리 단계를 트랜잭션 밖에서 하는 것입니다. 앞서 기반 기술에서 본 장시간 트랜잭션 문제를 피하기 위해서입니다.

### 1단계: 클레임 쿼리

```sql
WITH picked AS (
  SELECT id
  FROM jobs
  WHERE status = 'queued'
    AND queue = 'mail'
    AND run_after <= now()
  ORDER BY run_after, id
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs j
SET status       = 'running',
    attempts     = j.attempts + 1,
    locked_by    = 'worker-a1',
    locked_until = now() + interval '5 minutes'
FROM picked
WHERE j.id = picked.id
RETURNING j.id, j.payload, j.attempts;
```

이 문장 하나가 짧은 트랜잭션입니다. 먼저 CTE(Common Table Expression, `WITH`로 이름 붙인 임시 결과)에서 대기 행을 최대 10개 골라 잠그고, 이어서 같은 문장 안에서 그 행들의 상태를 `running`으로 바꾸고 리스 만료 시각을 기록한 뒤 `RETURNING`으로 처리할 내용을 돌려받습니다. 문장이 끝나 커밋되는 순간 잠금은 풀리지만 이미 `status = 'running'`이므로 다른 워커가 가져가지 못합니다. 즉 **행 잠금은 "클레임하는 찰나"만 보호하고, 그 뒤의 소유권은 `status`와 `locked_until` 컬럼이 표현**합니다. 한 번에 여러 건을 가져오면 왕복 횟수가 줄지만 한 워커가 오래 붙잡는 작업이 늘어나므로, 작업 처리 시간과 비교해 배치 크기를 정합니다.

참고로 `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`처럼 서브쿼리로 쓰는 변형도 널리 쓰이지만, 계획에 따라 서브쿼리가 의도와 다르게 평가될 수 있어 `LIMIT`과 잠금이 기대한 건수와 어긋나는 사례가 보고됩니다. 위처럼 CTE로 분리하면 읽기 쉽고, 그래도 의심스러우면 `EXPLAIN`으로 `LockRows`와 `Limit` 노드가 한 번씩만 실행되는지 확인하세요. 필요하면 `WITH picked AS MATERIALIZED (...)`로 CTE를 한 번만 계산하도록 강제할 수 있습니다.

### 2단계: 트랜잭션 밖에서 처리

```python
# 의사 코드: 처리 단계는 DB 트랜잭션 밖에서 실행한다
rows = claim_jobs(conn, queue="mail", worker="worker-a1", limit=10)
for job in rows:
    try:
        send_mail(job.payload)          # 외부 호출: 수 초가 걸릴 수 있음
        complete_job(conn, job.id)
    except Exception as e:
        fail_job(conn, job.id, str(e))
```

외부 API 호출은 느리고 실패할 수 있으므로 DB 연결을 트랜잭션 상태로 붙잡은 채 실행하지 않습니다. 이 단계에서는 데이터베이스 잠금이 없고, 소유권은 `locked_until`이라는 "빌린 시간"이 보호합니다.

### 3단계: 완료와 실패 기록

```sql
-- 성공: 소유자가 맞을 때만 완료로 전환
UPDATE jobs
SET status = 'done', finished_at = now(), locked_by = NULL, locked_until = NULL
WHERE id = :id AND status = 'running' AND locked_by = :worker;

-- 실패: 최대 횟수 전이면 지수 백오프로 재예약, 아니면 failed
UPDATE jobs
SET status       = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
    run_after    = now() + (interval '10 seconds' * power(2, attempts)),
    last_error   = :err,
    locked_by    = NULL,
    locked_until = NULL
WHERE id = :id AND status = 'running' AND locked_by = :worker;
```

두 문장 모두 `status = 'running' AND locked_by = :worker` 조건을 둡니다. 내 리스가 만료되어 다른 워커가 이 작업을 되찾아 간 뒤에 내가 뒤늦게 완료를 기록하는 사고를 막는 가드입니다. 영향받은 행이 0건이면 "내 작업이 아니게 됐다"는 신호이므로 결과를 버리거나 멱등성에 의존해 안전하게 넘깁니다. 지수 백오프(exponential backoff)는 실패할 때마다 대기 시간을 두 배씩 늘려 장애 중인 외부 시스템을 두드려 대지 않게 하는 방식이고, 위 식에서 `power(2, attempts)`가 그 역할을 합니다.

## 실패·재시도와 리스(lease)

워커가 `running` 상태로 바꾼 뒤 프로세스가 죽거나 네트워크가 끊기면 그 행은 영원히 `running`으로 남습니다. 이를 되찾는 장치가 리스입니다. 리스(lease)는 "이 작업을 5분간 빌려준다"는 계약으로, 기한이 지나면 소유권이 자동으로 풀립니다. 도서관 대출 기한이 지나면 책을 다른 사람이 빌릴 수 있는 것과 같습니다.

### 만료된 리스 되찾기

```sql
UPDATE jobs
SET status       = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
    last_error   = coalesce(last_error, '') || ' [lease expired]',
    run_after    = now(),
    locked_by    = NULL,
    locked_until = NULL
WHERE status = 'running'
  AND locked_until < now();
```

이 정리 쿼리를 1분 단위로 하나의 워커나 스케줄러가 실행합니다. 되찾은 작업은 다시 `queued`가 되어 다른 워커가 가져갑니다. 이때 중요한 점은 **되찾은 작업이 원래 워커에서 실제로 완료됐을 가능성**이 있다는 것입니다. 워커가 메일을 보낸 직후 완료 기록 전에 죽었다면 재시도로 메일이 한 번 더 나갑니다. 앞서 기반 기술에서 본 적어도 한 번 보장의 대가이며, 해결책은 작업 자체를 멱등하게 만드는 것입니다. 예를 들어 메일 발송 시스템에 `idempotency_key`를 함께 보내 중복 요청을 무시하게 하는 방식입니다.

### 리스 시간과 하트비트

리스가 너무 짧으면 정상적으로 오래 걸리는 작업이 중간에 되찾기 대상이 되어 중복 실행이 늘고, 너무 길면 죽은 워커의 작업이 오래 방치됩니다. 처리 시간의 상한을 알면 그보다 넉넉하게 정하고, 시간이 가변적이면 처리 중에 주기적으로 `locked_until`을 연장하는 하트비트(heartbeat, 살아 있음을 알리는 주기 신호) 쿼리를 보냅니다.

```sql
UPDATE jobs
SET locked_until = now() + interval '5 minutes'
WHERE id = :id AND status = 'running' AND locked_by = :worker;
```

이 문장은 매우 짧은 트랜잭션이므로 vacuum을 막지 않지만, 호출 빈도가 높으면 행 갱신이 늘어 죽은 튜플이 쌓입니다. 하트비트 주기는 리스 시간의 1/3 정도로 두는 것이 일반적인 출발점이며 실제 값은 직접 조정해야 합니다.

## 인덱스와 테이블 관리

큐 쿼리가 빠르려면 "처리 대기 행만 정렬된 상태로" 색인되어 있어야 합니다.

### 부분 인덱스

```sql
CREATE INDEX jobs_queued_idx
ON jobs (queue, run_after, id)
WHERE status = 'queued';

CREATE INDEX jobs_running_lease_idx
ON jobs (locked_until)
WHERE status = 'running';
```

첫 인덱스는 클레임 쿼리의 `WHERE`와 `ORDER BY`에 맞춘 것이고, 둘째는 만료된 리스를 찾는 정리 쿼리용입니다. 둘 다 `WHERE status = ...`가 붙은 부분 인덱스라서 `done`으로 쌓이는 수백만 행은 색인되지 않아 인덱스가 작게 유지됩니다. 단, 쿼리의 `WHERE status = 'queued'`가 인덱스 조건과 같은 형태여야 옵티마이저가 부분 인덱스를 쓸 수 있습니다. 상태 값을 바인드 변수로 넘기면 일반 계획에서는 부분 인덱스를 못 쓸 수 있으니 상수로 쓰는 것을 권합니다.

### 완료된 행의 정리와 파티셔닝

`done` 행이 계속 쌓이면 테이블이 커지고 vacuum 비용이 늘어납니다. 보존 기간이 지난 행을 지우는 배치를 작게 나눠 실행하거나, 날짜별 파티션(partition, 큰 테이블을 조각내 관리하는 기능)으로 나눠 오래된 파티션을 통째로 삭제하는 방법이 있습니다.

```sql
-- 한 번에 너무 많이 지우지 않도록 나눠서 삭제
DELETE FROM jobs
WHERE id IN (
  SELECT id FROM jobs
  WHERE status = 'done' AND finished_at < now() - interval '14 days'
  LIMIT 5000
);
```

### autovacuum 설정

갱신이 잦은 큐 테이블은 기본 autovacuum 임계값(전체 행의 20%가 죽은 뒤에 실행)이 너무 느슨할 수 있습니다. 테이블별로 더 자주 돌도록 조정할 수 있습니다.

```sql
ALTER TABLE jobs SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold    = 1000
);
```

이 값은 예시이며, 적용 후 `pg_stat_user_tables`의 죽은 튜플 수와 `last_autovacuum` 시각을 보며 조정해야 합니다.

## 다른 방식과의 비교와 선택 기준

데이터베이스 큐가 만능은 아닙니다. 대안과 비교해 선택 기준을 정리합니다.

| 방식 | 장점 | 단점 | 어울리는 상황 |
|---|---|---|---|
| `SKIP LOCKED` 큐 | 업무 트랜잭션과 원자적 등록, 추가 인프라 없음, SQL로 조회·수정 | 처리량 한계, 엄격한 FIFO 아님, vacuum 관리 필요 | 중소 규모, 데이터 정합성이 중요한 후속 작업 |
| 어드바이저리 락(`pg_try_advisory_lock`) | 행이 아닌 임의 키에 락, 테이블 변경 불필요 | 락 해제를 직접 관리, 세션 종료 시 해제됨 | 특정 리소스 단위의 단일 실행 보장 |
| `LISTEN/NOTIFY` | 새 작업 알림이 즉시 전달됨 | 알림은 저장되지 않아 유실 가능, 큐 대체 불가 | 폴링 간격을 줄이는 보조 신호 |
| 전용 브로커(RabbitMQ, Kafka 등) | 높은 처리량, 라우팅·보관·재생 기능 | 별도 운영 부담, 업무 트랜잭션과 분리됨 | 대규모·다수 소비자·이벤트 스트리밍 |

`LISTEN/NOTIFY`는 PostgreSQL이 제공하는 알림 기능으로 `NOTIFY jobs_channel`을 보내면 대기 중인 세션이 즉시 깨어납니다. 다만 알림 자체는 저장되지 않아 워커가 죽어 있는 동안 온 알림은 사라지므로, 큐 테이블을 기준으로 삼고 알림은 "지금 폴링해 보라"는 신호로만 쓰는 것이 안전합니다.

## 진단 쿼리와 점검 순서

운영 중 "작업이 안 줄어든다", "중복 실행이 생긴다" 같은 증상이 보일 때 쓸 수 있는 조회 쿼리를 모았습니다.

### 큐 상태 한눈에 보기

```sql
SELECT queue, status, count(*) AS cnt,
       min(run_after) AS oldest_due,
       max(attempts)  AS max_attempts_seen
FROM jobs
GROUP BY queue, status
ORDER BY queue, status;
```

`queued` 건수가 계속 늘면 소비 속도가 생산 속도보다 느린 것이고, `oldest_due`가 한참 과거라면 처리가 밀리고 있다는 신호입니다. `running`이 오래 유지되는 행은 리스 만료 쿼리와 비교해 봅니다.

### 오래 붙잡힌 작업과 잠금 확인

```sql
-- 리스가 만료됐는데 아직 running인 작업
SELECT id, locked_by, locked_until, attempts
FROM jobs
WHERE status = 'running' AND locked_until < now()
ORDER BY locked_until
LIMIT 50;

-- 열려 있는 오래된 트랜잭션: 큐 워커가 트랜잭션을 붙잡고 있는지 확인
SELECT pid, usename, state, xact_start, now() - xact_start AS xact_age, left(query, 80) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start
LIMIT 20;
```

두 번째 쿼리에서 `idle in transaction` 상태가 길게 보이면 워커가 트랜잭션을 연 채 외부 작업을 하고 있을 가능성이 높습니다. 이 경우 잠금이 오래 유지되고 vacuum도 막힙니다.

### 락과 죽은 튜플, 실행 계획

```sql
-- 현재 행 잠금을 쥔 세션과 대기 중인 세션
SELECT l.pid, l.mode, l.granted, a.state, left(a.query, 60) AS query
FROM pg_locks l
JOIN pg_stat_activity a USING (pid)
WHERE l.locktype IN ('relation','tuple','transactionid')
ORDER BY l.granted, l.pid;

-- 죽은 튜플과 autovacuum 상태
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'jobs';

-- 클레임 쿼리의 계획 확인: LockRows 노드와 인덱스 사용 여부
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM jobs
WHERE status = 'queued' AND queue = 'mail' AND run_after <= now()
ORDER BY run_after, id
LIMIT 10
FOR UPDATE SKIP LOCKED;
```

계획에서 `Index Scan using jobs_queued_idx` 아래로 `LockRows`, `Limit`이 보이면 의도대로입니다. `Seq Scan`이 나오면 부분 인덱스 조건과 쿼리가 맞지 않거나 통계가 낡았다는 뜻이므로 `ANALYZE jobs`를 실행하고 다시 확인합니다. `EXPLAIN ANALYZE`는 쿼리를 실제로 실행하므로 `FOR UPDATE SKIP LOCKED`가 있는 이 문장은 행을 잠그고 트랜잭션이 끝나면 풀립니다. 운영 DB에서는 `BEGIN; ... ROLLBACK;`으로 감싸서 실행하세요.

### 점검 순서

1. 큐 상태 조회로 `queued` 증가와 `oldest_due` 지연을 확인합니다.
2. `pg_stat_activity`에서 장시간 트랜잭션과 `idle in transaction`을 확인합니다.
3. 만료된 리스가 있는지 보고 정리 쿼리가 실행 중인지 확인합니다.
4. `EXPLAIN`으로 클레임 쿼리가 부분 인덱스를 타는지 확인합니다.
5. `pg_stat_user_tables`로 죽은 튜플 누적과 autovacuum 동작을 확인합니다.

## 업무 예시: 주문 확인 메일과 정산 배치

가상의 쇼핑몰을 예로 들겠습니다. 주문이 들어오면 확인 메일을 보내야 하고, 외부 메일 서비스는 가끔 느리거나 오류를 냅니다. 주문 저장 트랜잭션에서 `jobs`에 `queue = 'mail'` 작업을 함께 넣고, 워커 5개를 띄워 위의 클레임 쿼리로 건당 한 번에 10개씩 가져가 처리합니다. 외부 메일 서비스가 10분간 장애였다면 작업은 지수 백오프로 재예약되어 서비스가 복구된 뒤 자연스럽게 소진되고, 최대 시도 횟수를 넘긴 작업은 `failed`로 남아 사람이 사유를 보고 조치합니다. 이 시나리오는 설명을 위한 가상 예시이며 제가 실제 운영에서 수행한 사례가 아닙니다.

정산 배치처럼 순서가 중요한 작업은 다릅니다. 같은 가맹점의 정산 작업이 서로 다른 워커에서 순서가 바뀌어 처리되면 안 된다면, 큐를 가맹점 해시로 나눠(예: `queue = 'settle-' || (merchant_id % 8)`) 각 큐를 워커 하나가 전담하게 하는 방식으로 순서를 확보합니다. 이렇게 하면 큐 안에서는 엄격한 순서가, 큐 사이에서는 병렬성이 얻어집니다.

## 한계와 적용 기준 Q&A

### Q. SKIP LOCKED로 순서를 보장할 수 있나요?

A. 보장하지 못합니다. 잠긴 행을 건너뛰기 때문에 먼저 들어온 작업이 실패해 롤백되면 나중 작업이 먼저 처리될 수 있습니다. 순서가 필요하면 같은 키(고객, 가맹점 등)의 작업을 한 워커가 담당하도록 큐를 나누거나, 선행 작업 완료를 조건으로 확인하는 의존성 컬럼을 두세요. 순서 보장이 핵심 요구라면 단일 소비자 구성이나 순서를 지원하는 브로커를 검토합니다.

### Q. 처리량은 어디까지 나오나요?

A. 하드웨어, 작업 크기, 인덱스, 워커 수에 따라 크게 달라서 일반적인 수치를 단정할 수 없습니다. 행 하나가 여러 번 갱신되고 vacuum이 따라가야 하므로 초당 수천 건 이상이 필요하다면 반드시 직접 부하를 걸어 확인하세요. 한계가 보이면 배치 크기를 키우거나, 완료 행을 별도 보관 테이블로 옮기거나, 전용 브로커로의 전환을 검토합니다.

### Q. 연결 풀러(PgBouncer)와 같이 써도 되나요?

A. 이 글의 패턴은 클레임을 하나의 SQL 문(단문 트랜잭션)으로 끝내므로 트랜잭션 풀링 모드와도 잘 맞습니다. 반대로 세션 단위 어드바이저리 락이나 `LISTEN`은 세션 풀링이 필요합니다. 이미 게시한 글 「PgBouncer 연결 풀링」의 풀링 모드 설명을 함께 참고하세요.

### Q. 읽기 복제본에서 큐를 처리할 수 있나요?

A. 할 수 없습니다. `FOR UPDATE`는 쓰기 가능한 프라이머리에서만 실행할 수 있습니다. 읽기 복제본은 큐 상태 조회 용도로만 쓰세요.

### Q. 높은 격리 수준(REPEATABLE READ, SERIALIZABLE)에서도 쓸 수 있나요?

A. `SKIP LOCKED`는 어떤 격리 수준에서도 문법상 사용 가능하지만, 상위 격리 수준에서는 동시 갱신 충돌이 직렬화 오류(serialization failure)로 나타날 수 있어 재시도 코드가 필요합니다. 큐 클레임은 기본값인 `READ COMMITTED`에서 쓰는 것이 일반적입니다.

### Q. 어떤 경우에 쓰지 말아야 하나요?

A. 작업이 초대용량이어서 테이블 갱신 자체가 병목일 때, 같은 메시지를 여러 소비자 그룹에 각각 전달해야 할 때, 장기 보관과 재생이 핵심일 때는 맞지 않습니다. 또 `SKIP LOCKED`를 일반 보고서 조회에 쓰면 잠긴 행이 조용히 빠져 틀린 결과가 나오므로 절대 피해야 합니다.

## 마무리

`FOR UPDATE SKIP LOCKED`는 "잠긴 행은 남의 몫이니 건너뛴다"는 단순한 규칙으로 여러 워커의 병렬 처리를 가능하게 합니다. 하지만 이 옵션만으로 안전한 큐가 완성되지는 않습니다. 클레임은 짧은 단일 문장으로 끝내고, 처리는 트랜잭션 밖에서 하며, 소유권은 상태와 리스 컬럼으로 표현하고, 실패는 지수 백오프로 재시도하며, 중복 실행은 멱등성으로 견디는 것이 하나의 설계입니다. 부분 인덱스와 autovacuum 조정으로 테이블을 건강하게 유지하고, 진단 쿼리로 큐 적체와 장시간 트랜잭션을 점검하면 중소 규모의 큐는 데이터베이스 하나로 충분히 운영할 수 있습니다. 규모가 커지거나 요구가 발행·구독으로 바뀌면 그때 브로커로 옮기면 됩니다.

<h3 class="references-heading">참고 자료</h3>

- [PostgreSQL 공식 문서: SELECT — The Locking Clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [PostgreSQL 공식 문서: Explicit Locking — Row-Level Locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)
- [PostgreSQL 공식 문서: Transaction Isolation — Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)
- [PostgreSQL 공식 문서: Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
- [PostgreSQL 공식 문서: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [PostgreSQL 공식 문서: NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- [PostgreSQL 공식 문서: pg_locks 시스템 뷰](https://www.postgresql.org/docs/current/view-pg-locks.html)
