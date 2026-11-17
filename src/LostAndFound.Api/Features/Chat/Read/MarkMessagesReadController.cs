using System.ComponentModel.DataAnnotations;
using LostAndFound.Api.Features.Chat.Messages;
using LostAndFound.Api.Features.Identity;
using LostAndFound.Api.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Identity.Web.Resource;
using MongoDB.Driver;

namespace LostAndFound.Api.Features.Chat.Read;

[ApiController]
[Route("api/conversations/{conversationId:guid}/read")]
[Authorize]
[RequiredScope("access_as_user")]
public sealed class MarkMessagesReadController(
    ChatMessageService messages,
    ChatDbContext db) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> MarkRead(
        Guid conversationId,
        MarkMessagesReadRequest request,
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

        var filters = Builders<ChatMessage>.Filter;

        var filter = filters.And(
            filters.Eq(x => x.ConversationId, conversationId),
            filters.Ne(x => x.SenderUserId, userId),
            filters.In(x => x.Id, request.MessageIds));

        var update = Builders<ChatMessage>.Update
            .Set(x => x.IsRead, true);

        await db.Messages.UpdateManyAsync(
            filter,
            update,
            cancellationToken: cancellationToken);

        return NoContent();
    }
}

public sealed class MarkMessagesReadRequest
{
    [Required]
    [MinLength(1)]
    [MaxLength(100)]
    public Guid[] MessageIds { get; init; } = [];
}