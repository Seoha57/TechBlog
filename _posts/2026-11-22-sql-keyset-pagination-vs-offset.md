---
layout: post
title: "SQL 페이지네이션을 설계하는 법: OFFSET의 비용과 Keyset(Seek) 방식·인덱스·정렬 키 기준"
categories: [DBA]
tags: [dba, sql, pagination, keyset-pagination, offset, index, postgresql, performance]
description: "OFFSET 페이지네이션이 깊은 페이지에서 느려지는 이유와 중복·누락 문제를 설명하고, 유일한 정렬 키와 복합 인덱스로 Keyset(Seek) 방식을 설계하는 방법을 PostgreSQL 예시와 Oracle·MySQL 차이까지 함께 정리합니다."
---

## 먼저 답하기

### Q. 목록 화면의 "다음 페이지"는 `LIMIT ... OFFSET ...`이면 충분하지 않나요?

A. 데이터가 적고 앞쪽 몇 페이지만 보는 화면이라면 충분합니다. 문제는 페이지가 깊어질 때입니다. `OFFSET 100000`은 "앞의 10만 행을 건너뛰라"는 뜻이지만, 데이터베이스는 건너뛸 행을 **먼저 읽고 정렬 순서대로 세어서 버립니다**. 그래서 작업량이 건너뛰는 행 수에 비례해 늘어납니다. 또 사용자가 페이지를 넘기는 사이에 새 행이 들어오거나 지워지면, 같은 행이 두 번 보이거나 어떤 행이 건너뛰어지는 문제도 생깁니다. 이 두 가지가 OFFSET 방식의 대표적 약점입니다.

### Q. 그럼 무엇으로 바꾸나요?

A. **Keyset 페이지네이션**(seek method, 커서 방식이라고도 부름)을 씁니다. "몇 번째 행부터"가 아니라 "마지막으로 본 행의 정렬 키 값보다 뒤"라는 조건을 `WHERE`에 넣어, 인덱스에서 그 위치로 곧바로 이동한 뒤 필요한 만큼만 읽습니다. 작업량이 페이지 깊이와 거의 무관해집니다. 대신 임의의 페이지 번호로 점프하거나 전체 페이지 수를 보여 주는 기능은 제공하기 어렵습니다. 따라서 선택 기준은 "화면이 순차 탐색(더 보기, 무한 스크롤, 배치 순회)인가, 번호 점프가 필수인가"입니다. 이 글의 쿼리와 계획 예시는 설명을 위한 것이며, 실제 환경에서 직접 측정한 성능 수치가 아닙니다. 적용 전에 본인의 데이터와 버전에서 실행 계획을 확인하세요.

## 먼저 알아둘 기반 기술

### 페이지네이션이 무엇이고 왜 필요한가

페이지네이션(pagination)은 많은 행을 한 번에 가져오지 않고 일정한 크기로 나누어 보여 주는 방식입니다. 주문 목록 100만 건을 한 번에 내려보내면 네트워크, 애플리케이션 메모리, 브라우저가 모두 부담을 집니다. 그래서 화면에는 20건씩 보여 주고 다음 20건을 요청하는 구조를 씁니다. 이때 SQL에서 두 가지를 정해야 합니다. 어떤 순서로 줄 세울지(`ORDER BY`)와 어디서부터 몇 건을 가져올지입니다. 순서 없이 페이지를 나누면 의미가 없습니다. 관계형 데이터베이스는 `ORDER BY`가 없으면 결과 순서를 보장하지 않기 때문입니다.

### 인덱스와 정렬

B-tree 인덱스는 키 값이 정렬된 상태로 저장된 자료구조입니다. 인덱스 컬럼 순서와 정렬 방향이 `ORDER BY`와 맞으면, 데이터베이스는 별도의 정렬 작업 없이 인덱스를 차례대로 읽어 정렬된 결과를 얻을 수 있습니다. 또 특정 키 값 위치로 이동하는 탐색(seek)은 트리 높이만큼의 비용으로 끝납니다. 이 두 성질, 즉 "정렬된 순서로 읽기"와 "원하는 위치로 바로 이동"이 Keyset 방식의 기반입니다. 반대로 OFFSET은 이 위치 이동 능력을 활용하지 못하고 처음부터 세어 나갑니다.

### 용어 정리

| 용어 | 뜻 | 쉬운 예 |
| --- | --- | --- |
| OFFSET | 결과의 앞쪽 N행을 건너뛰는 절 | 책의 앞 100쪽을 넘기고 읽기 시작 |
| LIMIT / FETCH FIRST | 반환할 최대 행 수 | 한 번에 20건만 |
| Keyset(Seek) | 마지막 키 값 이후부터 읽는 방식 | 책갈피 위치부터 이어 읽기 |
| 커서(cursor) 토큰 | 다음 요청에 넘기는 마지막 키 값 | 책갈피 |
| 타이브레이커(tie-breaker) | 정렬 값이 같을 때 순서를 확정하는 추가 키 | 같은 시각이면 id로 구분 |
| 안정 정렬 | 같은 쿼리를 반복해도 같은 순서 | 매번 같은 줄 세우기 |

여기서 헷갈리기 쉬운 것이 DB의 "커서"와 API의 "커서 토큰"입니다. 데이터베이스 커서(DECLARE CURSOR)는 서버 쪽에서 결과 집합을 열어 두고 조금씩 가져오는 기능이고, 이 글의 커서 토큰은 클라이언트가 "마지막으로 본 키 값"을 들고 다니는 방식입니다. 이름은 같지만 서로 다른 개념입니다.

## OFFSET 방식이 느려지고 어긋나는 이유

### 작업량이 건너뛰는 행 수에 비례한다

다음은 주문 테이블을 최신순으로 20건씩 보여 주는 가장 흔한 쿼리입니다. 이 쿼리를 PostgreSQL 문법으로 적어 봅니다.

```sql
CREATE TABLE orders (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint      NOT NULL,
    status      text        NOT NULL,
    amount      numeric(12,2) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_created_id ON orders (created_at DESC, id DESC);

-- 1페이지
SELECT id, status, amount, created_at
  FROM orders
 ORDER BY created_at DESC, id DESC
 LIMIT 20 OFFSET 0;

-- 5,001페이지
SELECT id, status, amount, created_at
  FROM orders
 ORDER BY created_at DESC, id DESC
 LIMIT 20 OFFSET 100000;
```

두 쿼리는 같은 인덱스를 쓸 수 있지만 하는 일이 다릅니다. 첫 번째는 인덱스의 맨 앞에서 20개를 읽으면 끝나고, 두 번째는 인덱스를 100,020개 읽어서 앞의 100,000개를 버립니다. 실행 계획에서 이를 확인하려면 `EXPLAIN (ANALYZE, BUFFERS)`를 씁니다. 다음은 **형태를 설명하기 위한 가상의 출력**이며 실제 측정값이 아닙니다.

```text
 Limit  (actual time=... rows=20 loops=1)
   Buffers: shared hit=...
   ->  Index Scan using idx_orders_created_id on orders
         (actual time=... rows=100020 loops=1)
```

핵심은 `Limit`이 20행을 반환하는데 그 아래 `Index Scan`이 100,020행을 읽었다는 점입니다. 계획의 아래 노드가 읽은 행 수(`rows=100020`)와 위 노드가 반환한 행 수(`rows=20`)의 차이가 "읽고 버린 양"입니다. 이 차이를 보는 습관이 페이지네이션 성능 진단의 출발점입니다.

### 정렬 키가 유일하지 않으면 순서가 흔들린다

다음 쿼리는 흔한 실수를 보여 줍니다.

```sql
SELECT id, created_at FROM orders
 ORDER BY created_at DESC
 LIMIT 20 OFFSET 40;
```

`created_at`이 같은 행이 여러 건이면 그들 사이의 순서는 정해지지 않습니다. 같은 쿼리를 두 번 실행해도 실행 계획이나 물리적 위치에 따라 순서가 달라질 수 있고, 페이지 경계에 걸친 동순위 행이 앞 페이지와 뒤 페이지 양쪽에 나타나거나 어느 쪽에도 나타나지 않을 수 있습니다. 해결은 정렬 키 끝에 **유일한 컬럼(보통 기본 키)** 을 붙여 전체 정렬 순서를 확정하는 것입니다. 위 예시의 `ORDER BY created_at DESC, id DESC`가 그 형태입니다. 이 규칙은 OFFSET이든 Keyset이든 똑같이 필요합니다.

### 페이지 사이의 변경이 중복과 누락을 만든다

OFFSET은 "현재 시점의 결과에서 N번째부터"를 의미하기 때문에, 사용자가 1페이지를 본 뒤 2페이지를 요청하는 사이에 최신 행이 5건 추가되면 어떻게 될까요? 최신순 정렬에서는 새 행이 앞쪽에 끼어들어 기존 행이 5칸씩 뒤로 밀립니다. 2페이지(OFFSET 20)를 요청하면 1페이지 마지막 5건이 다시 나타납니다. 반대로 행이 삭제되면 그만큼 앞으로 당겨져 어떤 행은 영영 보이지 않습니다. 이는 쿼리의 잘못이 아니라 "위치 기반" 접근의 본질적 성질입니다. 위치가 아니라 값에 기대는 Keyset 방식은 이 문제를 상당 부분 피합니다.

## Keyset(Seek) 페이지네이션 설계

### 기본 아이디어

마지막으로 본 행의 정렬 키 값을 기억해 두었다가, 다음 요청에서 "그 값보다 뒤에 오는 행"만 조회합니다. 정렬 키가 `(created_at DESC, id DESC)`라면 "뒤"는 `(created_at, id)`가 마지막 값보다 **작은** 쪽입니다.

<figure class="article-figure"><img src="{{ '/assets/images/keyset-vs-offset-pagination.svg' | relative_url }}" alt="OFFSET 방식은 앞선 행을 읽고 버린 뒤 반환하지만 Keyset 방식은 마지막 키 값 이후 위치에서 인덱스를 탐색해 필요한 행만 읽는 구조"><figcaption>그림. OFFSET은 건너뛸 행을 읽고 버리지만 Keyset은 마지막 키 위치로 이동해 필요한 행만 읽는다. 이미지 출처: 직접 제작</figcaption></figure>

### PostgreSQL의 행 값 비교

PostgreSQL은 행 값 비교(row-wise comparison)를 지원해 복합 키 조건을 간결하게 쓸 수 있습니다.

```sql
-- 첫 페이지
SELECT id, status, amount, created_at
  FROM orders
 ORDER BY created_at DESC, id DESC
 LIMIT 20;

-- 다음 페이지: 직전 페이지 마지막 행이 (created_at='2026-11-20 10:15:00+09', id=84231)
SELECT id, status, amount, created_at
  FROM orders
 WHERE (created_at, id) < ('2026-11-20 10:15:00+09', 84231)
 ORDER BY created_at DESC, id DESC
 LIMIT 20;
```

`(created_at, id) < (값1, 값2)`는 사전식(lexicographic) 비교입니다. `created_at`이 더 작거나, `created_at`이 같으면서 `id`가 더 작은 행을 뜻합니다. 인덱스가 `(created_at DESC, id DESC)`로 정렬되어 있으므로 PostgreSQL은 마지막 키 위치로 이동한 뒤 그 뒤쪽 20개만 읽을 수 있습니다. 이때 정렬 방향이 모두 같은 방향(둘 다 DESC 또는 둘 다 ASC)이어야 행 값 비교와 인덱스가 자연스럽게 맞습니다. 방향이 섞이면 아래의 풀어쓴 형태가 필요합니다.

### 행 값 비교를 지원하지 않을 때: 풀어쓴 형태

모든 DBMS가 행 값 부등호 비교를 지원하거나 이를 인덱스 탐색 조건으로 효율적으로 활용하는 것은 아닙니다. 이식성을 위해 같은 조건을 `OR`로 풀어 쓸 수 있습니다.

```sql
SELECT id, status, amount, created_at
  FROM orders
 WHERE created_at < :last_created_at
    OR (created_at = :last_created_at AND id < :last_id)
 ORDER BY created_at DESC, id DESC
 LIMIT 20;
```

이 형태는 의미가 같지만 옵티마이저가 `OR`를 단일 인덱스 범위 탐색으로 처리하지 못해 인덱스 효율이 떨어지는 경우가 있습니다. 그럴 때는 `UNION ALL`로 두 범위를 나누어 각각 인덱스를 타게 하는 방법을 검토하되, 반드시 실행 계획으로 확인해야 합니다. 제품과 버전마다 최적화 방식이 다르므로 일반론으로 단정할 수 없습니다.

### 정렬 방향이 섞여 있을 때

예를 들어 "점수 내림차순, 같은 점수면 id 오름차순"처럼 방향이 섞인 경우에는 행 값 비교를 그대로 쓸 수 없습니다. 풀어쓴 형태로 표현합니다.

```sql
CREATE INDEX idx_posts_score_id ON posts (score DESC, id ASC);

SELECT id, title, score
  FROM posts
 WHERE score < :last_score
    OR (score = :last_score AND id > :last_id)
 ORDER BY score DESC, id ASC
 LIMIT 20;
```

인덱스도 `ORDER BY`와 같은 방향 조합으로 만들어야 정렬 작업 없이 읽을 수 있습니다. 인덱스 정의와 `ORDER BY`, `WHERE`의 키 순서·방향이 서로 맞는지 점검하는 일이 Keyset 설계의 핵심 작업입니다.

## 인덱스 설계와 필터 조건

### 필터가 있을 때 인덱스 컬럼 순서

실제 화면은 "특정 고객의 주문을 최신순으로"처럼 필터와 함께 쓰입니다. 이때 인덱스는 **같음 조건 컬럼을 앞에, 정렬 컬럼을 뒤에** 두는 것이 일반적인 원칙입니다.

```sql
CREATE INDEX idx_orders_cust_created_id
    ON orders (customer_id, created_at DESC, id DESC);

SELECT id, status, amount, created_at
  FROM orders
 WHERE customer_id = :customer_id
   AND (created_at, id) < (:last_created_at, :last_id)
 ORDER BY created_at DESC, id DESC
 LIMIT 20;
```

`customer_id = ...`로 인덱스의 한 구간을 고르고, 그 구간 안에서 `(created_at, id)` 순서로 이어 읽으니 정렬 없이 위치 이동만으로 끝납니다. 반대로 `status IN (...)`처럼 여러 값을 허용하는 필터가 앞에 오면 인덱스의 여러 구간을 합쳐 정렬해야 해서 이 이점이 줄어들 수 있습니다. 필터 조합이 다양하다면 가장 자주 쓰는 조합 몇 개에 맞춰 인덱스를 설계하고, 나머지는 허용 가능한 느림을 감수할지 판단해야 합니다.

### 인덱스 확인 쿼리

인덱스가 실제로 정렬을 대신하고 있는지는 실행 계획에서 별도의 정렬 노드(`Sort`)가 있는지로 확인합니다.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, amount, created_at
  FROM orders
 WHERE customer_id = 42
   AND (created_at, id) < ('2026-11-20 10:15:00+09', 84231)
 ORDER BY created_at DESC, id DESC
 LIMIT 20;
```

계획에 `Sort` 노드가 없고 `Index Scan`이 `Limit` 바로 아래에 있으며, 읽은 행 수가 20에 가깝다면 의도한 대로 동작하는 것입니다. 반대로 `Sort`가 보이거나 읽은 행 수가 수천 이상이라면 인덱스 컬럼 순서·방향이 `WHERE`·`ORDER BY`와 어긋난 것은 아닌지 점검합니다. 실제 크기와 통계에 따라 계획이 달라질 수 있으므로 운영과 비슷한 데이터량에서 확인해야 합니다.

### 커버링 인덱스로 테이블 접근 줄이기

목록 화면이 몇 개 컬럼만 보여 준다면 인덱스에 필요한 컬럼을 포함시켜 테이블 접근을 줄일 수 있습니다. PostgreSQL은 `INCLUDE` 절을 지원합니다.

```sql
CREATE INDEX idx_orders_cust_created_id_cov
    ON orders (customer_id, created_at DESC, id DESC)
    INCLUDE (status, amount);
```

다만 인덱스가 커지면 쓰기 비용과 저장 공간이 늘고, PostgreSQL에서는 가시성 정보(visibility map)가 갱신되어 있어야 테이블 접근 없이 인덱스만으로 답하는 Index Only Scan의 이점이 살아납니다. 조회 빈도와 쓰기 부담을 함께 고려해 선택해야 하는 항목입니다.

## 애플리케이션에서 커서 토큰 다루기

### 토큰에 담을 것

API는 다음 페이지를 요청할 때 마지막 행의 정렬 키 값을 "커서 토큰"으로 받습니다. 토큰에는 정렬 키 값들과, 필요하면 정렬 방향이나 필터 해시를 담습니다. 보통 JSON을 만들어 Base64URL로 인코딩해 불투명한(opaque) 문자열로 노출합니다. 클라이언트가 내용을 해석하거나 조작하지 않게 하기 위해서입니다.

```python
import base64, json

def encode_cursor(created_at, id_):
    raw = json.dumps({"c": created_at.isoformat(), "i": id_}).encode()
    return base64.urlsafe_b64encode(raw).decode()

def decode_cursor(token):
    data = json.loads(base64.urlsafe_b64decode(token.encode()))
    return data["c"], data["i"]
```

토큰은 서명되지 않은 Base64이므로 **암호화나 서명이 아닙니다**. 사용자가 토큰을 바꾸면 임의의 위치부터 조회할 수 있습니다. 조회 권한 검사는 토큰이 아니라 서버의 `WHERE` 조건(예: 본인 고객 번호)이 책임져야 하며, 토큰에 민감 값을 넣어서도 안 됩니다. 위·변조를 막고 싶다면 서버 비밀키로 서명(HMAC 등)을 붙이는 방법을 추가할 수 있습니다.

### 다음 페이지 존재 여부 판단

"다음 페이지가 있는가"를 알기 위해 `COUNT(*)`를 쓰면 다시 큰 비용이 듭니다. 대신 한 건 더 조회하는 방법을 씁니다. 화면에 20건을 보여 주려면 21건을 요청해, 21번째 행이 있으면 "다음 있음"으로 판단하고 응답에서는 20건만 돌려줍니다.

```python
def fetch_page(conn, limit, cursor=None):
    params = {"n": limit + 1}
    sql = "SELECT id, status, amount, created_at FROM orders "
    if cursor:
        sql += "WHERE (created_at, id) < (%(c)s, %(i)s) "
        params["c"], params["i"] = decode_cursor(cursor)
    sql += "ORDER BY created_at DESC, id DESC LIMIT %(n)s"
    rows = conn.execute(sql, params).fetchall()
    has_next = len(rows) > limit
    rows = rows[:limit]
    next_cursor = encode_cursor(rows[-1].created_at, rows[-1].id) if has_next else None
    return rows, next_cursor
```

이 방식은 전체 건수를 계산하지 않고도 "더 보기" 버튼의 표시 여부를 정확히 결정합니다. 전체 건수가 꼭 필요하다면 근사치(통계 기반 추정)로 대체하거나, 별도 집계 테이블·캐시를 두는 방법을 검토하세요.

### 이전 페이지로 돌아가기

Keyset은 기본적으로 한 방향 탐색입니다. 이전 페이지가 필요하면 정렬 방향을 반대로 뒤집어 조회한 뒤 애플리케이션에서 결과 순서를 다시 뒤집어 보여 줍니다.

```sql
-- 현재 페이지 첫 행이 (t, i)일 때 이전 페이지: 반대 방향으로 조회
SELECT * FROM (
    SELECT id, status, amount, created_at
      FROM orders
     WHERE (created_at, id) > (:first_created_at, :first_id)
     ORDER BY created_at ASC, id ASC
     LIMIT 20
) AS prev
ORDER BY created_at DESC, id DESC;
```

반대 방향 조회가 같은 인덱스를 거꾸로 읽을 수 있는지(B-tree는 양방향으로 읽을 수 있음)는 제품과 인덱스 정의에 따라 확인이 필요합니다. 양방향 이동이 복잡하다면 "이전" 기능을 포기하고 "처음으로"만 제공하는 단순한 UX도 현실적인 선택입니다.

## 다른 DBMS에서의 차이

### 문법과 최적화 차이

개념은 같지만 문법과 옵티마이저 동작이 제품마다 다릅니다. 아래 표는 확인해야 할 지점을 정리한 것이며, 세부 동작은 사용하는 버전의 공식 문서로 확인해야 합니다.

| 항목 | PostgreSQL | MySQL/MariaDB | Oracle | Tibero |
| --- | --- | --- | --- | --- |
| 행 수 제한 | `LIMIT n` 또는 `FETCH FIRST n ROWS ONLY` | `LIMIT n` | `FETCH FIRST n ROWS ONLY`(12c 이상), 이전 방식은 ROWNUM | 사용 버전 문서로 확인(ROWNUM 방식 일반적) |
| 건너뛰기 | `OFFSET n` | `OFFSET n` | `OFFSET n ROWS`(12c 이상) | 사용 버전 문서로 확인 |
| 행 값 부등호 비교 | 지원 | 문법 지원, 인덱스 활용은 버전별 확인 | 부등호 형태는 지원하지 않는 것으로 알려짐, 풀어쓴 형태 사용 | 사용 버전 문서로 확인, 풀어쓴 형태가 안전 |
| 권장 이식 형태 | 행 값 비교 | 풀어쓴 형태 + 실행 계획 확인 | 풀어쓴 형태 | 풀어쓴 형태 |

Oracle에서 풀어쓴 형태의 예는 다음과 같습니다.

```sql
SELECT id, status, amount, created_at
  FROM orders
 WHERE created_at < :last_created_at
    OR (created_at = :last_created_at AND id < :last_id)
 ORDER BY created_at DESC, id DESC
 FETCH FIRST 20 ROWS ONLY;
```

Tibero처럼 Oracle과 문법 호환성이 높은 제품에서는 비슷한 형태가 쓰이는 경우가 많지만, 지원 범위와 실행 계획은 버전에 따라 다르므로 사용 중인 버전에서 직접 실행 계획을 확인하는 것이 안전합니다. MySQL에서는 같은 조건을 쓰되 `EXPLAIN`으로 인덱스 범위 접근(`range`)이 사용되는지, 정렬 단계(`Using filesort`)가 없는지 확인합니다.

## OFFSET과 Keyset의 비교와 선택 기준

| 비교 항목 | OFFSET 방식 | Keyset 방식 |
| --- | --- | --- |
| 깊은 페이지 비용 | 건너뛰는 행 수에 비례해 증가 | 페이지 깊이와 거의 무관 |
| 임의 페이지 점프 | 쉬움(OFFSET = (n-1) × 크기) | 어려움(마지막 키가 필요) |
| 전체 페이지 수 | `COUNT(*)`로 계산 가능(비용 큼) | 보통 제공하지 않음 |
| 중간 변경에 대한 견고성 | 중복·누락 발생 가능 | 값 기준이라 상대적으로 안정 |
| 구현 복잡도 | 단순 | 키 설계·커서 토큰 필요 |
| 정렬 조건 변경 | 자유로움 | 정렬 키마다 인덱스·조건 필요 |
| 적합한 화면 | 관리자 화면, 소량 데이터 | 무한 스크롤, 피드, 배치 순회, API |

선택의 기준은 단순합니다. 데이터가 작거나 번호 점프가 꼭 필요한 관리 화면이라면 OFFSET이 합리적입니다. 대량 데이터를 순서대로 훑는 API, 피드, 내보내기 배치라면 Keyset이 맞습니다. 두 방식을 혼합해 앞쪽 몇 페이지는 OFFSET으로 제공하고 일정 깊이 이후는 막거나 Keyset으로 유도하는 방법도 있습니다. 한 가지 방식으로 모든 요구를 만족시키려 하기보다 화면별 요구를 나누어 보는 편이 실용적입니다.

## 업무 예시: 주문 내보내기 배치와 주문 목록 API

가상의 사례로 두 가지 요구를 나누어 보겠습니다. 쇼핑몰 운영팀에게 두 요구가 있다고 가정합니다. 하나는 고객별 주문 목록 API(앱에서 무한 스크롤), 다른 하나는 매일 새벽 전체 주문을 파일로 내보내는 배치입니다.

주문 목록 API는 `(customer_id, created_at DESC, id DESC)` 인덱스와 Keyset 방식을 씁니다. 응답에는 20건과 `next_cursor`를 담고, 클라이언트는 다음 요청에 토큰을 그대로 돌려보냅니다. 전체 건수는 보여 주지 않기로 했으므로 `COUNT(*)`는 필요 없습니다. 사용자가 목록을 보는 동안 새 주문이 생겨도 이미 본 항목이 반복되지 않습니다. 새 주문은 "맨 위로 새로고침" 때 첫 페이지 조회로 가져옵니다.

내보내기 배치는 기본 키만으로 순회합니다. 정렬 키가 단일 유일 컬럼이라 조건이 가장 단순합니다.

```sql
-- 배치: id 오름차순으로 10,000건씩 순회
SELECT id, customer_id, status, amount, created_at
  FROM orders
 WHERE id > :last_id
 ORDER BY id
 LIMIT 10000;
```

각 반복에서 마지막 `id`를 저장해 두면 중간에 배치가 실패해도 그 위치부터 재개할 수 있습니다. 이 점이 OFFSET 방식과의 큰 차이입니다. OFFSET은 재개를 위해 처리한 건수를 알아야 하는데, 그 사이에 데이터가 바뀌면 위치가 어긋납니다. 또 배치는 한 번에 거대한 결과를 열어 두는 대신 짧은 쿼리를 반복하므로 긴 트랜잭션과 락 점유를 피하는 데도 유리합니다. 다만 순회 중 이미 지나간 구간에 새 행이 들어오면 이번 실행에서는 보이지 않으므로, 내보내기의 기준 시점(예: 특정 시각 이전 데이터만)을 명시하는 것이 좋습니다. 이 사례는 설명을 위한 가정이며 실제 운영 결과가 아닙니다.

## 진단 쿼리와 점검 순서

### 느린 페이지네이션을 의심할 때

페이지가 깊어질수록 느려진다는 제보가 있으면 다음 순서로 점검합니다. 먼저 해당 쿼리의 실행 계획에서 읽은 행 수와 반환 행 수의 차이를 봅니다. 큰 차이가 있다면 OFFSET으로 인한 읽고 버리기입니다. 다음으로 `ORDER BY`가 인덱스와 맞는지, 정렬 노드가 있는지 봅니다. 그다음 정렬 키가 유일한지 확인합니다. 마지막으로 필터 조건과 인덱스 컬럼 순서가 맞는지 확인합니다.

PostgreSQL에서는 `pg_stat_statements` 확장이 설치되어 있다면 OFFSET이 들어간 쿼리 중 평균 실행 시간이 큰 것을 찾을 수 있습니다.

```sql
SELECT left(query, 100) AS query_head,
       calls,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round(total_exec_time::numeric, 2) AS total_ms
  FROM pg_stat_statements
 WHERE query ILIKE '%offset%'
 ORDER BY total_exec_time DESC
 LIMIT 10;
```

이 쿼리는 확장이 활성화되어 있고 권한이 있을 때만 동작합니다. `mean_exec_time` 같은 컬럼 이름은 PostgreSQL 13 이후의 이름이며 이전 버전은 다릅니다. 결과에서 호출 수가 많고 평균 시간이 큰 쿼리를 우선 후보로 삼되, OFFSET 값이 실제로 얼마나 큰지는 애플리케이션 로그나 파라미터 샘플로 따로 확인해야 합니다.

### 안정 정렬 검증

정렬 키가 유일하지 않은 쿼리를 찾는 간단한 확인도 도움이 됩니다. 정렬에 쓰는 컬럼 조합의 중복 여부를 조회합니다.

```sql
SELECT created_at, count(*) AS dup_cnt
  FROM orders
 GROUP BY created_at
HAVING count(*) > 1
 ORDER BY dup_cnt DESC
 LIMIT 10;
```

중복이 있다면 `created_at`만으로 정렬하면 동순위가 존재한다는 뜻이므로, `id` 같은 유일 컬럼을 정렬 끝에 반드시 붙여야 합니다. 이 쿼리는 큰 테이블에서 비용이 클 수 있으니 운영 중에는 통계 정보나 샘플 데이터로 먼저 확인하세요.

## OFFSET을 꼭 써야 할 때 비용을 줄이는 방법

### 지연된 조인(Deferred Join)

번호 점프가 필수라서 OFFSET을 포기할 수 없는 화면도 있습니다. 이때는 "건너뛰는 동안 읽는 데이터의 폭"을 줄이는 방법이 있습니다. 목록에 필요한 컬럼이 많거나 큰 컬럼이 섞여 있으면, 건너뛰는 행마다 테이블 본문까지 읽게 되어 낭비가 커집니다. 먼저 인덱스만으로 해당 페이지의 기본 키 20개를 구한 뒤, 그 키로 본 테이블을 조인해 나머지 컬럼을 가져오는 방식을 지연된 조인이라고 부릅니다.

```sql
SELECT o.id, o.status, o.amount, o.created_at, o.memo
  FROM orders o
  JOIN (
        SELECT id
          FROM orders
         ORDER BY created_at DESC, id DESC
         LIMIT 20 OFFSET 100000
       ) page ON page.id = o.id
 ORDER BY o.created_at DESC, o.id DESC;
```

안쪽 쿼리는 인덱스에 있는 컬럼만 읽으므로 테이블 본문 접근 없이 10만 행을 건너뛸 수 있고, 바깥 쿼리는 20건에 대해서만 본문을 읽습니다. 건너뛰는 행 수 자체가 줄어드는 것은 아니므로 깊은 페이지에서의 증가 추세는 남습니다. 효과는 인덱스와 컬럼 구성에 따라 다르며, 적용 전후의 실행 계획을 비교해야 합니다. 이 방법은 OFFSET의 한계를 완화할 뿐 해결하지는 않는다는 점을 기억하세요.

### 깊이 제한과 검색 유도

현실적으로 사용자가 5,000번째 페이지를 직접 넘기는 경우는 드뭅니다. 대부분 검색 조건을 좁히거나 정렬을 바꾸면 해결되는 요구입니다. 그래서 OFFSET의 최대값(예: 페이지 100까지만)을 제한하고 그 이상은 "조건을 좁혀 주세요"라고 안내하는 정책이 효과적일 때가 많습니다. 이렇게 하면 최악 비용에 상한이 생기고, 실수나 악의적 요청으로 깊은 OFFSET이 반복 호출되어 데이터베이스가 부하를 받는 상황도 막을 수 있습니다. 공개 API라면 한 번에 요청할 수 있는 크기(`limit`)에도 상한을 둡니다.

## 일관된 결과를 위한 트랜잭션과 스냅샷

### 페이지마다 다른 시점을 본다

Keyset이 값 기준이라 견고하다고 해도, 각 페이지 요청은 보통 **서로 다른 트랜잭션**입니다. 따라서 페이지 사이에 커밋된 변경은 다음 페이지에 반영됩니다. 이미 지나간 구간에 새로 들어온 행은 이번 순회에서 볼 수 없고, 아직 지나가지 않은 구간에 들어온 행은 보입니다. 이것이 잘못은 아니지만, 화면이나 배치가 "특정 시점의 일관된 스냅샷"을 요구한다면 따로 보장해야 합니다.

### 기준 시점 고정하기

일관성이 중요한 내보내기에서는 순회를 시작할 때 기준 값을 정해 둡니다. 예를 들어 시작 시점의 최대 `id`를 먼저 읽고, 모든 페이지 조회에 `id <= :max_id` 조건을 붙입니다.

```sql
-- 배치 시작 시 한 번
SELECT max(id) AS max_id FROM orders;

-- 이후 각 페이지 조회
SELECT id, customer_id, status, amount, created_at
  FROM orders
 WHERE id > :last_id
   AND id <= :max_id
 ORDER BY id
 LIMIT 10000;
```

기본 키가 단조 증가하는 테이블이라면 이 방법으로 "배치 시작 이후 추가된 행"을 일관되게 제외할 수 있습니다. 다만 기존 행의 수정은 반영될 수 있습니다. 완전한 스냅샷이 필요하다면 하나의 트랜잭션을 `REPEATABLE READ` 이상의 격리 수준으로 열어 두는 방법이 있지만, 긴 트랜잭션은 MVCC 기반 DBMS에서 오래된 버전 정리를 방해하는 등 부작용이 있으므로 비용을 이해하고 선택해야 합니다.

### 시퀀스 값의 함정

식별자가 시퀀스나 자동 증가 값일 때, 값이 반드시 커밋 순서와 일치하지는 않습니다. 트랜잭션 A가 id 100을 받고 아직 커밋하지 않은 상태에서 트랜잭션 B가 id 101을 받아 먼저 커밋할 수 있습니다. 이때 `id > :last_id` 순회가 101까지 읽고 지나간 뒤 A가 100을 커밋하면, 그 행은 이번 순회에서 누락됩니다. 실시간에 가까운 증분 수집이라면 이 현상을 고려해 일정 시간 지연된 구간까지만 읽거나, 변경 데이터 캡처 같은 별도 구조를 검토해야 합니다. 일일 배치처럼 기준 시점을 충분히 과거로 잡는 경우에는 영향이 작습니다.

## ORM과 프레임워크에서의 주의

많은 ORM이 `page`, `size` 파라미터를 받는 페이징 기능을 기본 제공하며, 내부적으로 OFFSET으로 변환합니다. 이런 기능은 편리하지만 깊은 페이지의 비용을 숨깁니다. 일부 프레임워크는 커서 기반 페이징을 별도로 제공하므로 공식 문서에서 지원 여부를 확인하세요. 또 컬렉션 조인과 페이징을 함께 쓰면 ORM이 결과를 메모리에서 잘라 내는 경우가 있어, 의도치 않게 전체를 읽어 오는 일이 생길 수 있습니다. 로그에 찍힌 실제 SQL에 `OFFSET`과 `LIMIT`이 들어 있는지, 정렬에 유일 키가 포함되어 있는지를 직접 확인하는 습관이 필요합니다.

## 페이지 크기와 응답 설계의 기준

페이지 크기(`limit`)는 너무 작으면 요청 횟수가 늘고, 너무 크면 한 번의 쿼리와 응답이 무거워집니다. 화면에 보이는 개수를 기준으로 20~50건 정도에서 시작해 응답 크기와 지연을 보며 조정하는 것이 무난하지만, 이 숫자는 예시일 뿐 업무와 행 크기에 따라 달라집니다. 공개 API에서는 기본값과 최대값을 함께 정해 두어, 클라이언트가 `limit=1000000`을 보내도 서버가 최대값으로 잘라 처리하게 해야 합니다. 응답에는 데이터 배열과 함께 `next_cursor`를 두고, 더 이상 없으면 `null`을 돌려주는 단순한 규칙이 클라이언트 구현을 쉽게 만듭니다.

## 도입 체크리스트

Keyset 방식을 도입하기 전에 다음 항목을 확인합니다. 첫째, 화면 요구가 순차 탐색인지 번호 점프인지 정리합니다. 둘째, 정렬 키 끝에 유일한 컬럼이 포함되어 있는지 확인합니다. 셋째, `WHERE`와 `ORDER BY`에 맞는 복합 인덱스가 있고 방향이 일치하는지 실행 계획으로 확인합니다. 넷째, 정렬 키에 NULL이 없는지, 값이 수정되지 않는지 확인합니다. 다섯째, 커서 토큰의 형식·검증·서명 정책을 정합니다. 여섯째, 기준 시점이나 일관성 요구가 있는지 정합니다. 일곱째, 이전 페이지·전체 건수 같은 포기하는 기능을 이해관계자와 합의합니다. 이 일곱 항목이 정리되면 구현은 대부분 단순한 `WHERE` 조건 한 줄로 귀결됩니다.

## 한계와 적용 기준 Q&A

### Q. Keyset이면 항상 OFFSET보다 빠른가요?

A. 정렬 조건에 맞는 인덱스가 있을 때 깊은 페이지에서 크게 유리합니다. 하지만 인덱스가 없거나 정렬·필터 조합이 인덱스와 맞지 않으면 큰 차이가 없고, 앞쪽 몇 페이지에서는 거의 같습니다. 방식을 바꾸기 전에 실제 쿼리의 실행 계획을 비교하세요. 이 글에서도 성능 수치를 제시하지 않았으며, 효과는 데이터 크기와 인덱스에 달려 있습니다.

### Q. 사용자가 정렬 기준을 바꿀 수 있는 화면은 어떻게 하나요?

A. 정렬 기준마다 별도의 인덱스와 쿼리가 필요합니다. 선택할 수 있는 정렬 기준이 많다면 인덱스 수가 늘어 쓰기 비용이 커집니다. 자주 쓰는 정렬만 Keyset으로 지원하고 나머지는 데이터 범위를 제한하거나 OFFSET을 얕은 페이지까지만 허용하는 절충이 현실적입니다. 자유로운 정렬과 검색 조합이 핵심 기능이라면 검색 엔진 같은 별도 구성도 검토 대상입니다.

### Q. 정렬 키 컬럼이 NULL을 가질 수 있으면 어떻게 되나요?

A. NULL은 비교 연산에서 참도 거짓도 아닌 "알 수 없음"으로 평가되므로 `<`, `>` 조건이 행을 걸러 내어 일부 행이 사라질 수 있습니다. 또 NULL이 정렬에서 맨 앞에 오는지 뒤에 오는지는 제품마다 기본값이 다릅니다. 가능하면 정렬 키는 `NOT NULL`로 설계하고, 불가피하다면 `COALESCE`로 대체 값을 정하거나 `NULLS FIRST/LAST`를 명시하며 NULL 구간의 조건을 별도로 처리해야 합니다.

### Q. 토큰의 마지막 행이 그 사이 삭제되면 문제가 생기나요?

A. Keyset 조건은 "그 값보다 뒤"라는 비교이므로 기준 행이 삭제되어도 조건 자체는 유효합니다. 이 점이 OFFSET보다 견고한 부분입니다. 다만 키 값이 수정되는 행(예: `updated_at` 기준 정렬에서 행이 갱신됨)은 정렬 위치가 바뀌어 중복·누락이 생길 수 있으므로, 정렬 키는 가능하면 불변 값(생성 시각, 기본 키)을 쓰세요.

### Q. 전체 페이지 수와 현재 페이지 번호를 꼭 보여 줘야 한다면요?

A. 그럴 때는 OFFSET을 쓰되 최대 페이지 수를 제한하거나, 전체 건수를 정확히 세지 않고 "약 N건"처럼 추정치를 쓰는 방법이 있습니다. 전체 건수 계산은 큰 테이블에서 비용이 크므로 캐시나 집계 테이블로 분리하는 방법도 있습니다. 요구가 정말 번호 점프인지, 사실은 "더 보기"로 충분한지 기획 단계에서 되묻는 것도 효과적입니다.

### Q. 보안상 주의할 점은 무엇인가요?

A. 커서 토큰은 클라이언트가 바꿀 수 있는 입력으로 취급해야 합니다. 토큰 값은 반드시 바인드 변수로 SQL에 전달해 SQL 인젝션을 막고, 토큰으로 접근 범위를 결정하지 말고 서버가 인증된 사용자 기준 필터를 항상 적용해야 합니다. 토큰 형식이 잘못되면 400 오류로 거절하고, 필요하면 서명이나 만료 시각을 붙여 위·변조와 오래된 토큰 사용을 막습니다.

## 마무리

OFFSET 페이지네이션은 구현이 쉽지만 깊은 페이지에서 읽고 버리는 작업이 늘고, 페이지 사이의 변경으로 중복·누락이 생깁니다. Keyset 방식은 유일한 정렬 키와 그에 맞는 복합 인덱스, 마지막 키를 담은 커서 토큰으로 이 문제를 풀지만, 번호 점프와 전체 페이지 수는 포기해야 합니다. 설계할 때는 먼저 화면이 순차 탐색인지 번호 점프가 필요한지 정하고, `ORDER BY` 끝에 기본 키를 붙여 순서를 확정하며, 필터와 정렬 컬럼에 맞는 인덱스를 만든 뒤 `EXPLAIN`으로 읽은 행 수와 정렬 노드를 확인하세요. 가장 느린 목록 쿼리 하나를 골라 실행 계획에서 "읽은 행 수 대비 반환 행 수"를 확인하는 것부터 시작하면 개선 여부가 분명해집니다.

<h3 class="references-heading">참고 자료</h3>

- [PostgreSQL 공식 문서: LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html)
- [PostgreSQL 공식 문서: Row and Array Comparisons](https://www.postgresql.org/docs/current/functions-comparisons.html)
- [PostgreSQL 공식 문서: Indexes and ORDER BY](https://www.postgresql.org/docs/current/indexes-ordering.html)
- [PostgreSQL 공식 문서: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [Oracle Database SQL Language Reference: SELECT (row limiting clause)](https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/SELECT.html)
- [Use The Index, Luke: Paging Through Results](https://use-the-index-luke.com/sql/partial-results/fetch-next-page)
