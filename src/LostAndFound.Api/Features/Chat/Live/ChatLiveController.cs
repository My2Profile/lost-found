using System.Net.WebSockets;
using LostAndFound.Api.Features.Chat.Messages;
using LostAndFound.Api.Features.Identity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Identity.Web.Resource;

namespace LostAndFound.Api.Features.Chat.Live;

[ApiController]
[Route("api/conversations/{conversationId:guid}")]
public sealed class ChatLiveController(
    ChatMessageService messages,
    ChatTickets tickets,
    ChatEvents events) : ControllerBase
{
    [HttpPost("ws-ticket")]
    [Authorize]
    [RequiredScope("access_as_user")]
    public async Task<IActionResult> IssueTicket(
        Guid conversationId,
        CancellationToken cancellationToken)
    {
        if (User.GetUserId() is not { } userId)
        {
            return Unauthorized();
        }

        var conversation =
            await messages.FindAccessibleConversationAsync(
                conversationId,
                userId,
                cancellationToken);

        if (conversation is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-store";

        return Ok(new
        {
            ticket = tickets.Issue(conversationId, userId),
            expiresInSeconds = 30
        });
    }

    [HttpGet("ws")]
    [AllowAnonymous]
    public async Task<IActionResult> Connect(
        Guid conversationId,
        [FromQuery] string ticket,
        CancellationToken cancellationToken)
    {
        if (!HttpContext.WebSockets.IsWebSocketRequest)
        {
            return BadRequest();
        }

        var access = tickets.Consume(ticket, conversationId);

        if (access is null)
        {
            return Unauthorized();
        }

        var conversation =
            await messages.FindAccessibleConversationAsync(
                conversationId,
                access.UserId,
                cancellationToken);

        if (conversation is null)
        {
            return NotFound();
        }

        using var socket =
            await HttpContext.WebSockets.AcceptWebSocketAsync();

        var subscription = events.Subscribe(conversationId);

        using var lifetime =
            CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken);

        lifetime.CancelAfter(TimeSpan.FromHours(1));

        try
        {
            await socket.SendAsync(
                "{\"type\":\"ready\"}"u8.ToArray(),
                WebSocketMessageType.Text,
                true,
                lifetime.Token);

            var sending = SendAsync(
                socket,
                subscription,
                lifetime.Token);

            var receiving = ReceiveAsync(
                socket,
                lifetime.Token);

            await Task.WhenAny(sending, receiving);

            lifetime.Cancel();

            try
            {
                await Task.WhenAll(sending, receiving);
            }
            catch (OperationCanceledException)
            {
            }
        }
        catch (WebSocketException)
        {
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            events.Remove(subscription);
            socket.Abort();
        }

        return new EmptyResult();
    }

    private static async Task SendAsync(
        WebSocket socket,
        ChatEvents.Subscription subscription,
        CancellationToken cancellationToken)
    {
        await foreach (
            var bytes in subscription.Queue.Reader
                .ReadAllAsync(cancellationToken))
        {
            await socket.SendAsync(
                bytes,
                WebSocketMessageType.Text,
                true,
                cancellationToken);
        }
    }

    private static async Task ReceiveAsync(
        WebSocket socket,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[1024];

        while (!cancellationToken.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(
                buffer,
                cancellationToken);

            if (result.MessageType == WebSocketMessageType.Close ||
                result.Count > 0)
            {
                return;
            }
        }
    }
}