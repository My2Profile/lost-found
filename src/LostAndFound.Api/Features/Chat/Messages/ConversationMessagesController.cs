using System.ComponentModel.DataAnnotations;
using LostAndFound.Api.Features.Identity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Identity.Web.Resource;
using LostAndFound.Api.Features.Chat;
using LostAndFound.Api.Features.Items;
using LostAndFound.Api.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace LostAndFound.Api.Features.Chat.Messages;

[ApiController]
[Route("api/conversations/{conversationId:guid}/messages")]
[Authorize]
[RequiredScope("access_as_user")]
public sealed class ConversationMessagesController(ChatMessageService messages, ChatEvents events, AppDbContext db, ChatDbContext chatDb) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Send(Guid conversationId, [FromBody] SendChatMessageRequest request, CancellationToken cancellationToken)
    {
        if(User.GetUserId() is not {} userId){
            return Unauthorized();
        }
        if(request.ClientMessageId == Guid.Empty)
        {
            ModelState.AddModelError(nameof(request.ClientMessageId), "Укажите ClientMessageId.");
        }

        if (string.IsNullOrWhiteSpace(request.Text))
        {
            ModelState.AddModelError(nameof(request.Text), "Введите сообщение.");
        }
        if (!ModelState.IsValid)
        {
            return ValidationProblem(ModelState);
        }

        var conversation = await messages.FindAccessibleConversationAsync(conversationId, userId, cancellationToken);

        if(conversation is null)
        {
            return NotFound();
        }

        // A returned item closes its chats: history stays readable, new messages are refused.
        var itemStatus = await db.FoundItems
            .AsNoTracking()
            .Where(x => x.Id == conversation.FoundItemId)
            .Select(x => (FoundItemStatus?)x.Status)
            .FirstOrDefaultAsync(cancellationToken);

        if (itemStatus != FoundItemStatus.Open)
        {
            return Conflict(new
            {
                message = "Вещь уже возвращена, чат закрыт."
            });
        }

        var result = await messages.SaveAsync(conversationId, userId, request.ClientMessageId, request.Text!, cancellationToken);

        if (result.Conflict)
        {
            return Conflict(new
            {
                message = "Этот ClientMessageId уже использован для другого текста"
            });
        }
        if (result.Created)
        {
            // A new message brings a deleted chat back for both people.
            await chatDb.Conversations.UpdateOneAsync(
                MongoDB.Driver.Builders<Conversation>.Filter.Eq(x => x.Id, conversationId),
                MongoDB.Driver.Builders<Conversation>.Update.Set(x => x.HiddenFor, new List<string>()),
                cancellationToken: cancellationToken);

            events.Publish(conversationId, new
            {
                type = "message",
                message = ChatMessageResponse.From(result.Message)
            });
        }

        return StatusCode(
            result.Created
                ? StatusCodes.Status201Created
                : StatusCodes.Status200OK,
            ChatMessageResponse.From(result.Message));
    }

    [HttpGet]
    public async Task<IActionResult> History(Guid conversationId, [FromQuery] MessageHistoryRequest request, CancellationToken cancellationToken)
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

        var page = await messages.ReadHistoryAsync(
            conversationId,
            request.Before,
            request.Limit,
            cancellationToken);

        if (page is null)
        {
            return BadRequest(new
            {
                message = "Курсор before не относится к сообщениям этого диалога."
            });
        }

        return Ok(page);
    }
}

public sealed class SendChatMessageRequest
{
    public Guid ClientMessageId { get; init; }

    [Required]
    [StringLength(ChatMessageService.MaxTextLength)]
    public string? Text { get; init; }
}

public sealed class MessageHistoryRequest
{
    public Guid? Before { get; init; }

    [Range(1, 100)]
    public int Limit { get; init; } = 30;
}