---
layout: post
title: "PostgreSQL 18의 비동기 I/O는 무엇을 바꾸는가"
date: 2026-09-16 00:00:00 +0900
categories: [dba]
tags: [dba, postgresql, postgresql18, aio, io_uring, performance]
---

PostgreSQL 18에서 가장 주목할 만한 변화 중 하나는 비동기 I/O(Asynchronous I/O, AIO)입니다. 먼저 I/O는 데이터베이스가 디스크나 네트워크에서 데이터를 읽고 쓰는 작업을 뜻합니다. 동기 I/O에서는 한 읽기 작업의 결과를 기다린 뒤 다음 작업으로 넘어가는 흐름이 흔하고, 비동기 I/O에서는 처리 가능한 읽기 요청을 겹쳐 준비해 대기 시간을 줄일 여지가 생깁니다. PostgreSQL 18은 데이터베이스가 디스크에서 페이지를 읽을 때마다 결과를 기다리는 방식에서 벗어나, 여러 읽기 요청을 준비하고 처리하는 구조를 도입했습니다.

다만 AIO를 “모든 쿼리를 빠르게 만드는 기능”으로 이해하면 곤란합니다. PostgreSQL 공식 문서가 설명하듯 PostgreSQL 18의 AIO는 순차 스캔, bitmap heap scan, VACUUM 같은 I/O 중심 작업을 주요 대상으로 합니다. 데이터가 이미 메모리 캐시에 있거나 CPU와 잠금이 병목인 경우에는 효과가 제한적일 수 있습니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. PostgreSQL 18로 업그레이드하면 모든 쿼리가 빨라지나요?</h3><p>A. 아닙니다. AIO는 디스크 읽기 대기와 관련된 작업을 대상으로 합니다. 캐시 적중률이 높거나 CPU, Lock, 네트워크가 병목이면 변화가 작을 수 있습니다.</p></div>
  <div class="quick-answer"><h3>Q. AIO를 사용하려면 애플리케이션을 수정해야 하나요?</h3><p>A. 데이터베이스 내부 I/O 처리 방식의 변화이므로 일반적인 SQL 사용 방식 자체를 바꿀 필요는 없습니다. 다만 운영자는 스토리지와 커널, 설정값의 조건을 확인해야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. 바로 io_uring으로 설정하면 되나요?</h3><p>A. 환경에 따라 다릅니다. PostgreSQL 18은 worker, io_uring, sync 방식을 제공하므로 운영체제와 PostgreSQL 빌드 조건, 워크로드를 확인한 뒤 선택해야 합니다.</p></div>
</section>

<figure class="article-figure">
  <img src="{{ '/assets/images/postgresql18-aio-flow.svg' | relative_url }}" alt="PostgreSQL 18 비동기 I/O 처리 흐름">
  <figcaption>이미지 출처: ChatGPT 생성</figcaption>
</figure>

## 데이터베이스 I/O가 병목이 되는 이유

데이터베이스는 테이블과 인덱스를 페이지 단위로 저장합니다. 쿼리가 필요한 페이지가 메모리 버퍼에 없으면 PostgreSQL은 스토리지에서 해당 페이지를 읽어야 합니다. 이때 스토리지의 응답을 기다리는 시간은 쿼리 처리 시간에 포함됩니다.

전통적인 동기 I/O 방식은 요청을 보내고 결과를 받은 뒤 다음 요청으로 넘어가는 흐름에 가깝습니다. 한 번의 요청 시간이 짧아도 수천 개의 페이지를 읽는 작업에서는 대기 시간이 누적될 수 있습니다. 특히 테이블 전체를 훑는 순차 스캔이나, 인덱스로 찾은 여러 페이지를 읽는 bitmap heap scan에서 이런 특성이 드러날 수 있습니다.

스토리지 장치의 특성도 달라졌습니다. 네트워크 기반 블록 스토리지와 NVMe 장치는 여러 I/O 요청을 동시에 처리할 수 있습니다. 반면 데이터베이스가 한 번에 하나의 요청만 보내고 결과를 기다린다면 저장장치의 병렬 처리 능력을 충분히 활용하지 못할 수 있습니다.

여기서 중요한 구분이 있습니다. 동기 I/O가 항상 나쁜 것은 아닙니다. 작은 랜덤 조회가 메모리 캐시에서 처리되는 OLTP 환경에서는 I/O 자체가 자주 발생하지 않을 수 있습니다. 반대로 큰 테이블을 읽거나 캐시 밖의 데이터를 다루는 작업에서는 읽기 요청을 겹쳐 처리하는 방식이 의미를 가질 수 있습니다.

PostgreSQL 17에서는 읽기 스트림과 미리 읽기 개선이 진행됐고, PostgreSQL 18에서는 더 일반적인 AIO 하위 시스템이 추가됐습니다. [pganalyze의 기술 분석](https://pganalyze.com/blog/postgres-18-async-io)은 이 변화를 PostgreSQL의 I/O 처리 구조가 바뀌는 과정으로 설명하면서, 환경별 성능 차이를 별도로 측정해야 한다고 강조합니다.

## PostgreSQL 18 AIO의 동작 방식

PostgreSQL 18은 `io_method` 설정으로 비동기 I/O 처리 방식을 선택합니다. 공식 문서에는 `worker`, `io_uring`, `sync`가 제시되어 있습니다. `worker`는 별도의 I/O worker 프로세스를 사용하고, `io_uring`은 Linux의 커널 인터페이스를 활용합니다. `sync`는 비동기 처리가 가능한 작업도 동기 방식으로 처리하는 선택지입니다.

다음 명령으로 현재 설정을 확인할 수 있습니다.

```sql
SHOW io_method;
SHOW io_workers;
SHOW io_max_concurrency;
SHOW effective_io_concurrency;
SHOW maintenance_io_concurrency;
```

`io_method`의 기본값은 빌드와 배포 환경에 따라 확인해야 합니다. `worker`를 사용하는 경우 `io_workers`가 worker 프로세스 수와 관련됩니다. `io_uring`은 PostgreSQL이 해당 방식으로 빌드되어야 하고, 운영체제와 라이브러리 조건도 필요합니다. PostgreSQL 문서는 `io_uring` 사용에 `liburing` 빌드 조건이 필요할 수 있다고 설명합니다.

비동기라는 말이 모든 작업이 동시에 끝난다는 뜻은 아닙니다. PostgreSQL이 읽기 요청을 큐에 넣고, 완료된 요청을 회수하며, 필요한 페이지를 버퍼에 반영하는 과정이 추가됩니다. 실제 이점은 요청을 겹쳐 처리할 수 있을 만큼 스토리지가 빠르고, 읽기 작업이 충분하며, 데이터가 캐시에 모두 들어 있지 않을 때 나타날 가능성이 큽니다.

PostgreSQL 18에는 `pg_aios` 시스템 뷰도 추가됐습니다. 이 뷰는 비동기 I/O와 관련된 파일 핸들 정보를 확인하는 데 사용할 수 있습니다. 기존의 `pg_stat_io`와 함께 보면 데이터베이스가 어떤 종류의 I/O를 수행하는지 파악하는 데 도움이 됩니다. 단, 특정 뷰의 수치만 보고 성능 개선을 단정해서는 안 됩니다. 쿼리 실행계획, 캐시 상태, 스토리지 지연시간을 함께 봐야 합니다.

## 성능 자료를 읽는 방법과 주의점

공개된 PostgreSQL 18 AIO 자료는 성능 개선 가능성을 보여주지만, 숫자를 그대로 운영 환경에 적용하면 안 됩니다. [pganalyze의 공개 벤치마크](https://pganalyze.com/blog/postgres-18-async-io)는 AWS 환경에서 PostgreSQL 17과 PostgreSQL 18의 여러 I/O 방식을 비교했습니다. 그 자료에서는 읽기 중심 작업에서 차이가 나타났지만, 이런 결과는 데이터 크기, 메모리, 스토리지, 커널, 동시 접속 수에 따라 달라질 수 있습니다.

[Tomas Vondra의 PostgreSQL 18 AIO 튜닝 글](https://vondra.me/posts/tuning-aio-in-postgresql-18/)도 특정 설정값을 무조건 권장하기보다, AIO의 장점과 함께 worker 수, 큐 깊이, 메모리 소비와 같은 trade-off를 살펴봐야 한다는 관점을 제공합니다. PostgreSQL 개발자와 커뮤니티 자료를 읽을 때도 테스트 환경과 측정 대상이 무엇인지 먼저 확인해야 합니다.

학술 연구에서도 io_uring의 효과는 작업 유형과 병목 위치에 따라 달라진다고 봅니다. [High-Performance DBMSs with io_uring](https://arxiv.org/abs/2512.04859)은 데이터베이스와 분석 작업에서 io_uring을 적용하는 조건을 분석하고, PostgreSQL 통합 사례를 포함합니다. 논문에 성능 향상 수치가 있더라도 그것은 해당 연구의 환경에서 관찰된 결과입니다. 특정 스토리지와 데이터셋의 결과를 모든 서비스의 기준으로 삼을 수는 없습니다.

따라서 DBA가 공개 벤치마크를 읽을 때는 다음 질문을 먼저 확인하는 편이 좋습니다.

- 데이터가 메모리 캐시에 있었는가, 디스크에서 읽었는가
- 순차 스캔, bitmap heap scan, VACUUM 중 어떤 작업을 측정했는가
- 스토리지는 로컬 NVMe인가, 네트워크 블록 스토리지인가
- `io_method` 외에 shared buffers와 동시성 설정은 같았는가
- 평균값만 비교했는가, p95·p99 지연시간도 확인했는가

이 기준을 확인해야 “AIO가 빠르다”는 문장을 “어떤 조건의 어떤 작업에서 개선 가능성이 관찰됐다”로 정확하게 바꿔 이해할 수 있습니다.

## DBA가 검토할 적용 기준

PostgreSQL 18 AIO를 검토할 때 첫 단계는 설정값을 바꾸는 것이 아니라 workload를 분류하는 것입니다. 대표 쿼리의 실행계획에서 Seq Scan이나 Bitmap Heap Scan이 나타나는지, 읽기 데이터가 shared buffers에 자주 적중하는지, 스토리지 지연이 실제 대기 원인인지 확인해야 합니다.

예를 들어 다음과 같은 쿼리는 분석 대상이 될 수 있습니다.

```sql
EXPLAIN (ANALYZE, BUFFERS, I/O TIMING)
SELECT order_date, customer_id, total_amount
FROM orders
WHERE order_date >= DATE '2026-01-01'
  AND order_date < DATE '2026-02-01';
```

이 명령은 실행계획과 버퍼 사용량, I/O 관련 정보를 확인하는 예시입니다. 중요한 점은 이 명령을 실행했다고 해서 AIO의 효과를 측정한 것이 아니라는 사실입니다. AIO 전후를 비교하려면 동일한 데이터, 동일한 캐시 조건, 동일한 동시성, 동일한 스토리지 조건을 통제해야 합니다. 직접 측정하지 않은 경우에는 공개 자료의 조건을 인용하고, 독자의 환경에서는 별도 검증이 필요하다고 밝혀야 합니다.

운영 반영도 단계적으로 접근해야 합니다. 먼저 개발 또는 스테이징 환경에서 PostgreSQL 버전과 빌드 옵션을 확인합니다. 그 다음 대표적인 읽기 작업과 VACUUM 작업의 지표를 수집합니다. 변경 전후에는 쿼리 지연시간, I/O 대기, CPU 사용량, worker 프로세스, 스토리지 queue depth를 함께 관찰해야 합니다.

설정 변경에는 되돌릴 기준도 필요합니다. 특정 설정이 읽기 작업에는 도움이 되더라도 worker 프로세스가 CPU를 더 사용하거나, 다른 workload의 지연시간을 높일 수 있습니다. `io_method` 변경은 트래픽이 낮은 시간에 진행하고, 변경 전 설정을 기록하며, 문제가 발생했을 때 이전 값으로 돌아갈 절차를 준비하는 편이 안전합니다.

<section class="quick-answers">
  <p class="quick-label">DBA 적용 Q&A</p>
  <div class="quick-answer"><h3>Q. 어떤 서비스에서 먼저 검토할까요?</h3><p>A. 대용량 테이블 조회, 분석성 조회, bitmap heap scan, VACUUM 시간이 운영 이슈로 이어지는 서비스부터 검토하는 편이 합리적입니다.</p></div>
  <div class="quick-answer"><h3>Q. OLTP 조회가 항상 빨라지나요?</h3><p>A. 아닙니다. 짧은 인덱스 조회가 메모리 캐시에서 처리되는 경우에는 AIO가 주요 병목이 아닐 수 있습니다. 캐시 적중률과 실제 디스크 읽기를 함께 확인해야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. 가장 안전한 도입 방법은 무엇인가요?</h3><p>A. 공개 자료의 조건을 이해한 뒤, 스테이징에서 대표 workload를 분류하고, 변경 전후 지표와 rollback 기준을 정한 다음 점진적으로 적용하는 방법입니다.</p></div>
</section>

PostgreSQL 18의 AIO는 DBA가 스토리지와 데이터베이스 실행을 함께 바라보게 만드는 변화입니다. 하지만 새로운 설정 하나로 성능 문제가 자동 해결되는 기능은 아닙니다. 공식 문서와 공개 연구의 조건을 읽고, 자신의 workload가 어떤 I/O 패턴을 가지는지 판단하는 과정이 먼저입니다.

### 참고 자료

- [PostgreSQL 18 Release Notes](https://www.postgresql.org/docs/18/release-18.html)
- [PostgreSQL 18 Resource Consumption](https://www.postgresql.org/docs/18/runtime-config-resource.html)
- [pganalyze: Waiting for Postgres 18](https://pganalyze.com/blog/postgres-18-async-io)
- [Tomas Vondra: Tuning AIO in PostgreSQL 18](https://vondra.me/posts/tuning-aio-in-postgresql-18/)
- [High-Performance DBMSs with io_uring](https://arxiv.org/abs/2512.04859)
