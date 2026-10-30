# Board dự án

Board là trang web riêng của mỗi dự án để chủ dự án xem từng feature và duyệt ở
các cổng. Dữ liệu nằm trong GitHub Issues của repo dự án
(`tracker.kind: github`), nên Symphony và board đọc cùng một nguồn; board không
có cơ sở dữ liệu riêng. Mã nằm ở [`board/`](../board/) của lõi và được
`sync-project` chép vào `.project-os/board/` của dự án.

## Board hiển thị gì

| Cột       | Issue đang mở có nhãn                | Nút                                   |
| --------- | ------------------------------------ | ------------------------------------- |
| Ý tưởng   | `idea` (hoặc chưa có nhãn giai đoạn) | Duyệt G1 → Kế hoạch, Sửa lại, Dừng    |
| Kế hoạch  | `plan`                               | Duyệt G2 → gắn `ready`, Sửa lại, Dừng |
| Sẵn sàng  | `ready`                              | Tạm dừng                              |
| Đang làm  | `ready` + `in_progress`              | Tạm dừng agent                        |
| Chờ duyệt | `human_review` hoặc `pilot_review`   | Duyệt và merge PR, Yêu cầu sửa, Dừng  |
| Bị chặn   | `blocked`                            | Gỡ chặn, Gỡ chặn kèm ghi chú, Dừng    |
| Xong      | issue đã đóng (20 issue gần nhất)    | —                                     |

Mỗi thẻ có ưu tiên (nhãn `priority-now`, `priority-next`, `priority-later`),
cổng đang chờ, PR liên kết (PR có `Closes #N` trong mô tả), trạng thái CI và
link preview. Preview lấy từ dòng `Preview: https://...` trong mô tả PR, hoặc từ
GitHub Deployments của commit đầu PR.

Mỗi nút để lại một bình luận trên issue, ghi quyết định và ghi chú của chủ dự án.
"Sửa lại" bắt buộc có ghi chú. "Duyệt và merge PR" merge kiểu squash đúng commit
đang hiển thị; nếu agent vừa đẩy commit mới thì GitHub từ chối và board báo lỗi.
"Dừng" ở Ý tưởng, Kế hoạch, Chờ duyệt, Bị chặn sẽ đóng issue (không làm nữa).

## Triển khai trên Dokploy

1. Tạo fine-grained token chỉ cho repo dự án với quyền: Issues đọc/ghi, Pull
   requests đọc/ghi, Contents đọc/ghi (để merge), Checks đọc, Deployments đọc,
   Metadata đọc. Đây là token riêng của board, khác token của Symphony.
2. Trong Dokploy, tạo Application từ repo dự án, kiểu build Dockerfile, đường dẫn
   `.project-os/board/Dockerfile`, build context là thư mục gốc repo.
3. Biến môi trường:
   - `GITHUB_TOKEN`: token ở bước 1.
   - `BOARD_PASSWORD`: mật khẩu đăng nhập, ít nhất 12 ký tự.
   - `BOARD_SESSION_SECRET`: chuỗi ngẫu nhiên dài; giữ phiên đăng nhập qua các
     lần khởi động lại. Thiếu biến này thì mỗi lần deploy phải đăng nhập lại.
4. Gắn domain có HTTPS, cổng 8080. Cookie đăng nhập chỉ gửi qua HTTPS.
5. Mở domain, đăng nhập. Board tự làm mới mỗi phút; nút ↻ tải lại ngay.

Sai mật khẩu 5 lần thì khoá đăng nhập 5 phút. Phiên đăng nhập kéo dài 30 ngày.

Chạy thử trên máy:
`BOARD_PASSWORD=... GITHUB_TOKEN=... BOARD_INSECURE_COOKIE=1 PORT=8080 node .project-os/board/server.mjs`
từ thư mục gốc dự án, rồi mở `http://localhost:8080`.
